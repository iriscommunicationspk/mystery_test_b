const db = require("../../database/sql");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
  sendPasswordResetEmail,
  sendPasswordResetConfirmationEmail,
} = require("../../utils/mail");

const { v4: uuidv4 } = require("uuid");
const { validateEmail } = require("../../utils/validators");
const { sendEmail } = require("../../services/emailService");
const { formatRolePermissions } = require("../../utils/formatters");
const authLogger = require("../../services/authLogger");
const activityLogger = require("../../services/activityLogger");

// Helper function to create sessions table if it doesn't exist
async function ensureSessionsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(512) NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY (token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("Sessions table verified/created");
  } catch (error) {
    console.error("Error ensuring sessions table exists:", error);
  }
}

// Helper function to flush connection caches
async function flushConnectionCache() {
  try {
    // Create a fresh connection
    const connection = await db.getConnection();

    // Execute a flush query to ensure no query cache is used
    await connection.query("SET SESSION query_cache_type = 0");

    // Set session variables to prevent caching
    await connection.query("SET SESSION interactive_timeout = 60");
    await connection.query("SET SESSION wait_timeout = 60");

    // Release the connection back to the pool
    connection.release();

    console.log("Connection cache flushed");
  } catch (error) {
    console.error("Error flushing connection cache:", error);
  }
}

// Call these at server startup
ensureSessionsTable();
flushConnectionCache();

async function signUpNewUser(request, response) {
  try {
    const {
      first_name,
      last_name,
      phone,
      email,
      password,
      role,
      system_role,
      type = "internal",
      client_id = "",
    } = request.body;

    // Generate a UUID for the user
    const uuid = uuidv4();

    const name = `${first_name} ${last_name}`;

    // Check if email or password is missing
    if (!email || !password) {
      return response
        .status(400)
        .json({ message: "Email and password are required." });
    }

    // Check if the email already exists in the database
    const existingUser = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);
    if (existingUser[0]?.length > 0) {
      return response.status(400).json({ message: "Email is already in use." });
    }

    // Validate client_id if provided
    if (client_id) {
      // Check if the client_id exists in the clients table
      const [clientCheck] = await db.query(
        "SELECT * FROM clients WHERE uuid = ?",
        [client_id]
      );

      if (clientCheck.length === 0) {
        return response.status(400).json({
          message: "Invalid client_id. The specified client does not exist.",
        });
      }

      console.log(`Verified client_id ${client_id} exists in clients table.`);
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Get a connection to use with transactions
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Determine system_role based on client_id value
      let finalSystemRole = system_role;

      // If client_id has a value, set system_role to client_user
      if (client_id) {
        finalSystemRole = "client_user";
        console.log(
          `Setting system_role to client_user for user with client_id: ${client_id}`
        );
      } else {
        finalSystemRole = system_role || "admin"; // Default to admin if not provided and no client_id
      }

      // Insert the new user into the database (now without client_id in users table)
      const [result] = await connection.query(
        `INSERT INTO users (uuid, first_name, last_name, name, email, phone, password, role, system_role, type, client_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid,
          first_name,
          last_name,
          name,
          email,
          phone || null, // Ensure phone is defined, or set it to NULL
          hashedPassword,
          role || "admin",
          finalSystemRole, // Use the determined system_role
          type, // Add type value explicitly
          client_id,
        ]
      );

      if (!result.affectedRows) {
        await connection.rollback();
        return response.status(500).json({ message: "Error creating user." });
      }

      // If it's an external user (client user), add to client_users table
      if (type === "external" && client_id) {
        const [clientUserResult] = await connection.query(
          `INSERT INTO client_users (user_id, client_id) VALUES (?, ?)`,
          [uuid, client_id]
        );

        if (!clientUserResult.affectedRows) {
          await connection.rollback();
          return response.status(500).json({
            message: "Error associating user with client.",
          });
        }
      }

      // Commit the transaction
      await connection.commit();

      // Get the admin user to log this activity (if exists)
      let adminId = null;
      try {
        const [admins] = await db.query(
          "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
        );
        if (admins.length > 0) {
          adminId = admins[0].id;
        }
      } catch (error) {
        console.error("Error getting admin user for activity logging:", error);
      }

      // Log user creation activity if we have an admin
      if (adminId) {
        const ipAddress =
          request.headers["x-forwarded-for"] ||
          request.socket.remoteAddress ||
          "unknown";

        await activityLogger.logActivity(
          adminId,
          "New User Created",
          `Created user: ${email} with role: ${role || "admin"}`,
          ipAddress
        );
      }

      // Send user data back in the response
      return response.status(200).json({
        message:
          type === "external"
            ? "User created successfully"
            : "Sign up successful!",
        // token,
        user: result,
      });
    } catch (error) {
      await connection.rollback();
      console.error("Unexpected error:", error);
      return response.status(500).json({
        message: "Database error while creating user.",
        error: error.message,
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    return response.status(500).json({ message: "Internal Server Error" });
  }
}

async function signIn(request, response) {
  try {
    // Set cache control headers to prevent caching
    response.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private"
    );
    response.set("Pragma", "no-cache");
    response.set("Expires", "0");

    // Flush connection cache to prevent any stale database connections
    await flushConnectionCache();

    const { email, password, publicIp } = request.body;
    // Get client IP address
    const ipAddress =
      publicIp || // Use client-provided public IP if available
      request.headers["x-forwarded-for"] ||
      request.socket.remoteAddress ||
      "unknown";

    // Get MAC address if available
    // Note: Getting MAC address on the server side is generally not possible directly
    // We'll check if the client sent it in a header or in the request body
    const macAddress =
      request.headers["x-mac-address"] || request.body.macAddress || null;

    // Check if email and password are provided
    if (!email || !password) {
      return response
        .status(400)
        .json({ message: "Email and password are required." });
    }

    // Fetch the user from the database
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      // Record failed login attempt with a dummy user ID of 0
      await authLogger.recordLoginAttempt(0, ipAddress, macAddress, "Failed");
      return response
        .status(401)
        .json({ message: "Invalid email or password." });
    }

    const user = users[0];

    // Compare the provided password with the stored hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      // Record failed login attempt with the real user ID
      await authLogger.recordLoginAttempt(
        user.id,
        ipAddress,
        macAddress,
        "Failed"
      );
      return response
        .status(401)
        .json({ message: "Invalid email or password." });
    }

    // Record successful login attempt
    await authLogger.recordLoginAttempt(
      user.id,
      ipAddress,
      macAddress,
      "Success"
    );

    // Log this activity for the system activity feed
    await activityLogger.logActivity(
      user.id,
      "User Login",
      `User logged in from ${ipAddress}`,
      ipAddress
    );

    // Generate a JWT token
    const token = jwt.sign(
      {
        email: user.email,
        user_id: user.id, // Add user_id to the token payload
      },
      "mystery_shopping_secret",
      {
        expiresIn: "2h", // Set token expiration time
      }
    );

    // Ensure sessions table exists
    await ensureSessionsTable();

    // Get a connection to use with transactions
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      console.log(`Clearing existing sessions for user ID: ${user.id}`);

      // Clear any existing sessions for this user
      await connection.query("DELETE FROM sessions WHERE user_id = ?", [
        user.id,
      ]);

      console.log(
        `Inserting new session for user ID: ${
          user.id
        } with token: ${token.substring(0, 10)}...`
      );

      // Store the new session
      const [sessionResult] = await connection.query(
        "INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)",
        [user.id, token, new Date(Date.now() + 2 * 60 * 60 * 1000)]
      );

      console.log(`Session insert result: ${JSON.stringify(sessionResult)}`);

      await connection.commit();
      console.log("Session transaction committed successfully");
    } catch (error) {
      await connection.rollback();
      console.error("Error managing sessions during sign-in:", error);
      return response
        .status(500)
        .json({ message: "Error managing user session", error: error.message });
    } finally {
      connection.release();
    }

    delete user.password;

    // Send back the user data and token
    return response.status(200).json({
      message: "Sign in successful!",
      user: user,
      token,
    });
  } catch (error) {
    console.error("Unexpected error during sign-in:", error.message);
    return response.status(500).json({ message: "Internal Server Error" });
  }
}

async function signOut(request, response) {
  try {
    // Set cache control headers to prevent caching
    response.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private"
    );
    response.set("Pragma", "no-cache");
    response.set("Expires", "0");

    // Flush connection cache to prevent any stale database connections
    await flushConnectionCache();

    // Ensure sessions table exists
    await ensureSessionsTable();

    const token = request.headers.authorization?.split(" ")[1]; // Extract the token

    if (!token) {
      return response
        .status(400)
        .json({ message: "Authorization token is missing." });
    }

    // Get the user ID from the token
    let userId;
    try {
      const decoded = jwt.verify(token, "mystery_shopping_secret");
      const [users] = await db.query("SELECT id FROM users WHERE email = ?", [
        decoded.email,
      ]);
      userId = users[0]?.id;

      console.log(
        `Signing out user ID: ${userId} with token: ${token.substring(
          0,
          10
        )}...`
      );

      if (userId) {
        // Delete all sessions for this user to ensure complete logout across all devices
        const [deleteResult] = await db.query(
          "DELETE FROM sessions WHERE user_id = ?",
          [userId]
        );
        console.log(
          `Sessions deleted for user ID ${userId}: ${deleteResult.affectedRows} row(s)`
        );
      } else {
        // If we can't find the user, just delete the specific token
        const [deleteResult] = await db.query(
          "DELETE FROM sessions WHERE token = ?",
          [token]
        );
        console.log(
          `Sessions deleted by token: ${deleteResult.affectedRows} row(s)`
        );
      }
    } catch (error) {
      console.error("Error decoding token during signout:", error);
      // If token verification fails, still try to delete the session by token
      const [deleteResult] = await db.query(
        "DELETE FROM sessions WHERE token = ?",
        [token]
      );
      console.log(
        `Sessions deleted by token (after error): ${deleteResult.affectedRows} row(s)`
      );
    }

    // Log the logout activity if we have a valid user ID
    if (userId) {
      const ipAddress =
        request.headers["x-forwarded-for"] ||
        request.socket.remoteAddress ||
        "unknown";

      await activityLogger.logActivity(
        userId,
        "User Logout",
        "User logged out",
        ipAddress
      );
    }

    return response.status(200).json({
      message: "Logged out user successfully!",
    });
  } catch (error) {
    console.error("Unexpected error during sign-out:", error.message);
    return response.status(500).json({ message: "Internal Server Error" });
  }
}

async function currentUser(request, response) {
  try {
    // Set cache control headers to prevent caching
    response.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private"
    );
    response.set("Pragma", "no-cache");
    response.set("Expires", "0");

    // Ensure sessions table exists
    await ensureSessionsTable();

    // Extract token from the Authorization header
    const token = request.headers.authorization?.split(" ")[1];

    if (!token) {
      return response
        .status(401)
        .json({ message: "Authorization token is missing." });
    }

    // Verify the token
    let decoded;
    try {
      decoded = jwt.verify(token, "mystery_shopping_secret");
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return response.status(401).json({ message: "Token has expired." });
      }
      return response.status(401).json({ message: "Invalid token." });
    }

    console.log(
      `Verifying token for currentUser: ${token.substring(0, 10)}...`
    );

    // Check if token exists in sessions table
    const [sessions] = await db.query(
      "SELECT * FROM sessions WHERE token = ?",
      [token]
    );
    console.log(`Found ${sessions.length} sessions for this token`);

    if (sessions.length === 0) {
      return response
        .status(401)
        .json({ message: "Session expired or invalid. Please login again." });
    }

    // Log token contents for debugging
    console.log("Token payload:", decoded);

    // Check if we have a new format token (with user_id) or old format (email only)
    if (decoded.user_id) {
      // New token format with user_id
      console.log("Using new token format with user_id");

      // Fetch the user from the database using BOTH email AND id from the token
      const [users] = await db.query(
        "SELECT * FROM users WHERE email = ? AND id = ?",
        [decoded.email, decoded.user_id]
      );

      if (users.length === 0) {
        console.warn(
          `User not found or mismatch. Token claims email: ${decoded.email}, id: ${decoded.user_id}`
        );
        return response
          .status(404)
          .json({ message: "User not found or token mismatch." });
      }

      const user = users[0];
      delete user.password; // Don't send the password back

      console.log(
        `User authenticated using new token format: ${user.email} (ID: ${user.id})`
      );

      return response.status(200).json({
        message: "Current user retrieved successfully!",
        data: { user },
      });
    } else {
      // Old token format (email only)
      console.log("Using legacy token format (email only)");

      // Fetch the user from the database using only email (old behavior)
      const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
        decoded.email,
      ]);

      if (users.length === 0) {
        return response.status(404).json({ message: "User not found." });
      }

      const user = users[0];
      delete user.password; // Don't send the password back

      console.log(
        `User authenticated using legacy token: ${user.email} (ID: ${user.id}) - consider refreshing token`
      );

      return response.status(200).json({
        message: "Current user retrieved successfully!",
        data: { user },
      });
    }
  } catch (error) {
    console.error("Unexpected error getting current user:", error.message);
    return response.status(500).json({ message: "Internal Server Error" });
  }
}

/**
 * Refresh an expired token
 * @param {Object} request - Express request object
 * @param {Object} response - Express response object
 */
async function refreshToken(request, response) {
  try {
    // Ensure sessions table exists
    await ensureSessionsTable();

    // Extract token from the Authorization header
    const oldToken = request.headers.authorization?.split(" ")[1];

    if (!oldToken) {
      return response
        .status(401)
        .json({ message: "Authorization token is missing." });
    }

    // Attempt to verify the token without expiration check
    let decoded;
    try {
      // First try to verify normally
      decoded = jwt.verify(oldToken, "mystery_shopping_secret");

      // Check if the token exists in the sessions table
      const [sessions] = await db.query(
        "SELECT * FROM sessions WHERE token = ?",
        [oldToken]
      );
      if (sessions.length === 0) {
        return response
          .status(401)
          .json({ message: "Session expired or invalid. Please login again." });
      }

      // If it succeeds, the token is still valid, just return it
      return response.status(200).json({
        message: "Token is still valid.",
        token: oldToken,
      });
    } catch (err) {
      // Check if the error is specifically about expiration
      if (err.name !== "TokenExpiredError") {
        // If it's any other error, the token is invalid for reasons other than expiration
        return response
          .status(401)
          .json({ message: "Invalid token.", error: err.message });
      }

      // If we're here, the token has expired but might be valid otherwise
      // Decode without verification to get the email
      decoded = jwt.decode(oldToken);

      if (!decoded || !decoded.email) {
        return response.status(401).json({ message: "Invalid token format." });
      }
    }

    // Fetch the user from the database using the email from the token
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      decoded.email,
    ]);

    if (users.length === 0) {
      return response.status(404).json({ message: "User not found." });
    }

    const user = users[0];

    // Generate a new JWT token
    const newToken = jwt.sign(
      {
        email: user.email,
        user_id: user.id, // Add user_id to refreshed token
      },
      "mystery_shopping_secret",
      {
        expiresIn: "2h", // Set token expiration time
      }
    );

    // Get a connection to use with transactions
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Update the session in the database
      await connection.query(
        "UPDATE sessions SET token = ?, expires_at = ? WHERE token = ?",
        [newToken, new Date(Date.now() + 2 * 60 * 60 * 1000), oldToken]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      console.error("Error updating token during refresh:", error);
      return response.status(500).json({ message: "Error refreshing token" });
    } finally {
      connection.release();
    }

    delete user.password; // Don't send the password back

    // Send back the user data and new token
    return response.status(200).json({
      message: "Token refreshed successfully!",
      user: user,
      token: newToken,
    });
  } catch (error) {
    console.error("Unexpected error during token refresh:", error);
    return response.status(500).json({ message: "Internal Server Error" });
  }
}

async function getUserRoles(request, response) {
  try {
    // Query database to get all user roles
    const [roles] = await db.query("SELECT * FROM user_roles");

    return response.status(200).json(roles);
  } catch (error) {
    console.error("Error getting user roles:", error.message);
    return response.status(500).json({
      error: error.message,
      message: "Error fetching user roles!",
    });
  }
}

async function addUserRole(request, response) {
  try {
    const { role } = request.body;

    // Validate input
    if (!role) {
      return response.status(400).json({ message: "Role name is required." });
    }

    // Check if role already exists
    const [existingRoles] = await db.query(
      "SELECT * FROM user_roles WHERE role = ?",
      [role]
    );

    if (existingRoles.length > 0) {
      return response.status(400).json({ message: "Role already exists." });
    }

    // Insert the new role
    const [result] = await db.query(
      "INSERT INTO user_roles (role) VALUES (?)",
      [role]
    );

    if (!result.affectedRows) {
      return response.status(500).json({ message: "Error creating role." });
    }

    return response.status(200).json({
      message: "Role created successfully!",
      roleId: result.insertId,
    });
  } catch (error) {
    console.error("Error adding user role:", error.message);
    return response.status(500).json({
      error: error.message,
      message: "Error adding user role!",
    });
  }
}

async function deleteUserRole(request, response) {
  try {
    const { id } = request.params;

    // Validate input
    if (!id) {
      return response.status(400).json({ message: "Role ID is required." });
    }

    // Check if role exists
    const [existingRoles] = await db.query(
      "SELECT * FROM user_roles WHERE id = ?",
      [id]
    );

    if (existingRoles.length === 0) {
      return response.status(404).json({ message: "Role not found." });
    }

    // Delete the role
    const [result] = await db.query("DELETE FROM user_roles WHERE id = ?", [
      id,
    ]);

    if (!result.affectedRows) {
      return response.status(500).json({ message: "Error deleting role." });
    }

    return response.status(200).json({
      message: "Role deleted successfully!",
    });
  } catch (error) {
    console.error("Error deleting user role:", error.message);
    return response.status(500).json({
      error: error.message,
      message: "Error deleting user role!",
    });
  }
}

/**
 * Handles the forgot password functionality
 * Generates a password reset token and stores it in the database
 * Sends an email with the reset link
 */
async function forgotPassword(request, response) {
  try {
    const { email } = request.body;

    // Validate email
    if (!email) {
      return response.status(400).json({
        message: "Email address is required.",
      });
    }

    // Check if the user exists
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    // For security reasons, we'll return a success message even if the email doesn't exist
    // This prevents email enumeration attacks
    if (users.length === 0) {
      return response.status(200).json({
        message:
          "If your email is registered, you will receive a password reset link shortly.",
      });
    }

    const user = users[0];

    // Generate a unique reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // Set expiration time (1 hour from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Check if a reset token already exists for this user
    const [existingTokens] = await db.query(
      "SELECT * FROM password_reset_tokens WHERE user_id = ?",
      [user.id]
    );

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Delete any existing tokens for this user
      if (existingTokens.length > 0) {
        await connection.query(
          "DELETE FROM password_reset_tokens WHERE user_id = ?",
          [user.id]
        );
      }

      // Save the new token to the database
      await connection.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) 
         VALUES (?, ?, ?)`,
        [user.id, tokenHash, expiresAt]
      );

      await connection.commit();

      // Send the password reset email
      try {
        await sendPasswordResetEmail(
          email,
          resetToken,
          user.first_name ? `${user.first_name} ${user.last_name}` : email
        );
        console.log(`Password reset email sent to ${email}`);

        // Log password reset request activity
        const ipAddress =
          request.headers["x-forwarded-for"] ||
          request.socket.remoteAddress ||
          "unknown";

        await activityLogger.logActivity(
          user.id,
          "Password Reset Requested",
          `Password reset requested for email: ${email}`,
          ipAddress
        );
      } catch (emailError) {
        console.error("Failed to send password reset email:", emailError);
        // Note: we don't return an error to the client for security reasons
        // The token is still created and valid even if email sending fails
      }

      return response.status(200).json({
        message: "Password reset link has been sent to your email.",
      });
    } catch (error) {
      await connection.rollback();
      console.error("Error generating reset token:", error);
      return response.status(500).json({
        message: "An error occurred while processing your request.",
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Forgot password error:", error);
    return response.status(500).json({
      message: "An error occurred while processing your request.",
    });
  }
}

/**
 * Handles resetting a user's password with a valid reset token
 */
async function resetPassword(request, response) {
  try {
    const { token, email, password } = request.body;

    // Validate required fields
    if (!token || !email || !password) {
      return response.status(400).json({
        message: "Token, email, and new password are required.",
      });
    }

    // Check if password meets minimum requirements
    if (password.length < 6) {
      return response.status(400).json({
        message: "Password must be at least 6 characters long.",
      });
    }

    // Find the user by email
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      return response.status(400).json({
        message: "Invalid or expired reset token.",
      });
    }

    const user = users[0];

    // Hash the provided token to compare with stored hash
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Look up the token in the database
    const [tokenRecords] = await db.query(
      "SELECT * FROM password_reset_tokens WHERE user_id = ? AND token = ? AND expires_at > NOW()",
      [user.id, tokenHash]
    );

    if (tokenRecords.length === 0) {
      return response.status(400).json({
        message: "Invalid or expired reset token.",
      });
    }

    // Token is valid, proceed with password reset
    const hashedPassword = await bcrypt.hash(password, 10);

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Update the user's password
      await connection.query("UPDATE users SET password = ? WHERE id = ?", [
        hashedPassword,
        user.id,
      ]);

      // Delete the used token
      await connection.query(
        "DELETE FROM password_reset_tokens WHERE user_id = ?",
        [user.id]
      );

      // Log password reset activity
      const ipAddress =
        request.headers["x-forwarded-for"] ||
        request.socket.remoteAddress ||
        "unknown";

      await activityLogger.logActivity(
        user.id,
        "Password Reset",
        "User reset their password",
        ipAddress
      );

      await connection.commit();

      // Send confirmation email
      try {
        await sendPasswordResetConfirmationEmail(
          email,
          user.first_name ? `${user.first_name} ${user.last_name}` : email
        );
        console.log(`Password reset confirmation email sent to ${email}`);
      } catch (emailError) {
        console.error(
          "Failed to send password reset confirmation email:",
          emailError
        );
        // We don't want to fail the password reset if only the email fails
        // The password has already been successfully reset
      }

      return response.status(200).json({
        message:
          "Password has been reset successfully. You can now log in with your new password.",
      });
    } catch (error) {
      await connection.rollback();
      console.error("Error resetting password:", error);
      return response.status(500).json({
        message: "An error occurred while resetting your password.",
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Reset password error:", error);
    return response.status(500).json({
      message: "An error occurred while processing your request.",
    });
  }
}

/**
 * Validates a password reset token
 * This is used to verify the token is valid before showing the reset form
 */
async function validateToken(request, response) {
  try {
    const { token, email } = request.body;

    // Validate required fields
    if (!token || !email) {
      return response.status(400).json({
        message: "Token and email are required.",
      });
    }

    // Find the user by email
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      return response.status(400).json({
        message: "Invalid or expired reset token.",
      });
    }

    const user = users[0];

    // Hash the provided token to compare with stored hash
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Look up the token in the database
    const [tokenRecords] = await db.query(
      "SELECT * FROM password_reset_tokens WHERE user_id = ? AND token = ? AND expires_at > NOW()",
      [user.id, tokenHash]
    );

    if (tokenRecords.length === 0) {
      return response.status(400).json({
        message: "Invalid or expired reset token.",
      });
    }

    // Token is valid
    return response.status(200).json({
      message: "Token is valid",
      valid: true,
    });
  } catch (error) {
    console.error("Validate token error:", error);
    return response.status(500).json({
      message: "An error occurred while validating your token.",
    });
  }
}

const authController = {
  signUpNewUser,
  signIn,
  signOut,
  currentUser,
  refreshToken,
  getUserRoles,
  addUserRole,
  deleteUserRole,
  forgotPassword,
  resetPassword,
  validateToken,
};

module.exports = authController;
