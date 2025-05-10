const db = require("../../database/sql");

async function fetch(request, response) {
  try {
    // Get page and limit from query parameters, with default values
    const page = parseInt(request.query.page, 50) || 1;
    const limit = parseInt(request.query.limit, 50) || 100;

    // Calculate the offset
    const offset = (page - 1) * limit;

    // Query the database to fetch users with pagination without the WHERE clause
    const [users] = await db.query("SELECT * FROM users LIMIT ? OFFSET ?", [
      limit,
      offset,
    ]);

    // Query the database to get the total count of users
    const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM users");

    // Send the users and pagination data as a response
    return response.status(200).json({
      data: users,
      pagination: {
        total,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
      },
      message: "Users fetched successfully!",
    });
  } catch (error) {
    console.error("Error fetching users:", error.message);

    // Handle errors and send an appropriate response
    return response.status(400).json({
      error: error.message,
      message: "Error fetching users!",
    });
  }
}

async function get_user(request, response) {
  try {
    const { id } = request.params;

    // Check if ID is provided
    if (!id) {
      return response.status(400).json({ message: "User ID is required." });
    }

    // Query the database to fetch the specific user with client details
    const [users] = await db.query(
      `SELECT u.*, c.name as client_name, c.email as client_email, c.first_name as client_first_name, c.last_name as client_last_name
       FROM users u
       LEFT JOIN clients c ON u.client_id = c.uuid
       WHERE u.uuid = ?`,
      [id]
    );

    // Check if user exists
    if (users.length === 0) {
      return response.status(404).json({ message: "User not found." });
    }

    // Send the user data as a response
    return response.status(200).json({
      data: users[0],
      message: "User fetched successfully!",
    });
  } catch (error) {
    console.error("Error fetching user:", error.message);

    // Handle errors and send an appropriate response
    return response.status(400).json({
      error: error.message,
      message: "Error fetching user!",
    });
  }
}

async function update_user(request, response) {
  try {
    const { id } = request.params;
    const updateData = request.body;

    // Check if ID is provided
    if (!id) {
      return response.status(400).json({ message: "User ID is required." });
    }

    // Get a connection from the database
    const connection = await db.getConnection();

    try {
      // If email is being updated, check if it's already in use by another user of the same client
      if (updateData.email) {
        // First, get the current user's client_id
        const [currentUser] = await connection.query(
          "SELECT client_id FROM users WHERE uuid = ?",
          [id]
        );

        if (currentUser.length === 0) {
          return response.status(404).json({ message: "User not found." });
        }

        const clientId = currentUser[0].client_id;

        // Now check for duplicate emails only within that client
        const [existingUsers] = await connection.query(
          "SELECT * FROM users WHERE email = ? AND uuid != ? AND client_id = ?",
          [updateData.email, id, clientId]
        );

        if (existingUsers.length > 0) {
          return response.status(400).json({
            message:
              "Email address is already in use by another user in this client.",
          });
        }
      }

      // If client_id is being updated, verify that the new client exists
      if (updateData.client_id) {
        const [clientCheck] = await connection.query(
          "SELECT * FROM clients WHERE uuid = ?",
          [updateData.client_id]
        );

        if (clientCheck.length === 0) {
          return response.status(400).json({
            message: "Invalid client_id. The specified client does not exist.",
          });
        }

        // Update system_role to client_user if client_id is provided
        updateData.system_role = "client_user";
      }

      // Start building the SQL query dynamically based on provided fields
      let sql = "UPDATE users SET ";
      const values = [];
      const updateFields = [];

      // Add fields to update
      if (updateData.first_name) {
        updateFields.push("first_name = ?");
        values.push(updateData.first_name);
      }

      if (updateData.last_name) {
        updateFields.push("last_name = ?");
        values.push(updateData.last_name);
      }

      if (updateData.email) {
        updateFields.push("email = ?");
        values.push(updateData.email);
      }

      if (updateData.phone) {
        updateFields.push("phone = ?");
        values.push(updateData.phone);
      }

      if (updateData.role) {
        updateFields.push("role = ?");
        values.push(updateData.role);
      }

      if (updateData.client_id) {
        updateFields.push("client_id = ?");
        values.push(updateData.client_id);
      }

      if (updateData.system_role) {
        updateFields.push("system_role = ?");
        values.push(updateData.system_role);
      }

      // Update name field (combination of first and last name)
      if (updateData.first_name || updateData.last_name) {
        // First get the current user data
        const [currentUser] = await connection.query(
          "SELECT first_name, last_name FROM users WHERE uuid = ?",
          [id]
        );

        if (currentUser.length > 0) {
          const firstName =
            updateData.first_name || currentUser[0].first_name || "";
          const lastName =
            updateData.last_name || currentUser[0].last_name || "";
          const fullName = `${firstName} ${lastName}`.trim();

          updateFields.push("name = ?");
          values.push(fullName);
        }
      }

      // If no fields to update, return
      if (updateFields.length === 0) {
        return response.status(400).json({ message: "No fields to update." });
      }

      // Complete the SQL query
      sql += updateFields.join(", ") + " WHERE uuid = ?";
      values.push(id);

      // Execute the update query
      const [result] = await connection.query(sql, values);

      // Check if any row was updated
      if (result.affectedRows === 0) {
        return response.status(404).json({ message: "User not found." });
      }

      return response
        .status(200)
        .json({ message: `User with ID ${id} updated successfully.` });
    } finally {
      // Release the connection back to the database
      connection.release();
    }
  } catch (error) {
    console.error("Error updating user:", error.message);
    return response.status(500).json({
      error: error.message,
      message: "Error updating user!",
    });
  }
}

async function fetch_client_users(request, response) {
  try {
    // Get page and limit from query parameters, with default values
    const client_id = request.query.client_id;
    const page = parseInt(request.query.page, 10) || 1;
    const limit = parseInt(request.query.limit, 10) || 10;

    // Calculate the offset
    const offset = (page - 1) * limit;

    if (!client_id) {
      return response.status(400).json({
        error: "Client ID is required",
        message: "Client ID is required to fetch users!",
      });
    }

    // Query the database to fetch users with client details using JOIN
    const [users] = await db.query(
      `SELECT cu.*, c.name as client_name, c.email as client_email
       FROM users cu
       LEFT JOIN clients c ON cu.client_id = c.uuid
       WHERE cu.client_id = ? 
       LIMIT ? OFFSET ?`,
      [client_id, limit, offset]
    );

    // Query the database to get the total count of users for this client
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total 
       FROM users
       WHERE client_id = ?`,
      [client_id]
    );

    // Send the users and pagination data as a response
    return response.status(200).json({
      data: users,
      pagination: {
        total,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
      },
      message: "Users fetched successfully!",
    });
  } catch (error) {
    console.error("Error fetching users:", error.message);

    // Handle errors and send an appropriate response
    return response.status(400).json({
      error: error.message,
      message: "Error fetching users!",
    });
  }
}

async function delete_user(request, response) {
  try {
    const { id } = request.params;

    // Check if ID is provided
    if (!id) {
      return response.status(400).json({ message: "User ID is required." });
    }

    // Delete from users table
    const [result] = await db.query("DELETE FROM users WHERE uuid = ?", [id]);

    // Check if any row was deleted
    if (result.affectedRows === 0) {
      return response.status(404).json({ message: "User not found." });
    }

    return response
      .status(200)
      .json({ message: `User with ID ${id} deleted successfully.` });
  } catch (error) {
    console.error("Error deleting user:", error.message);
    return response.status(500).json({
      error: error.message,
      message: "Error deleting user!",
    });
  }
}

async function upload_users(request, response) {
  try {
    const { client_id } = request.body;

    if (!client_id) {
      return response.status(400).json({
        success: false,
        message: "Client ID is required.",
      });
    }

    const fileBuffer = request.file?.buffer;
    if (!fileBuffer) {
      return response.status(400).json({
        success: false,
        message: "No file provided.",
      });
    }

    // Check if client exists
    const [clientResult] = await db.query(
      "SELECT * FROM clients WHERE uuid = ?",
      [client_id]
    );

    if (clientResult.length === 0) {
      return response.status(404).json({
        success: false,
        message: "Client not found.",
      });
    }

    const XLSX = require("xlsx");
    const { v4: uuidv4 } = require("uuid");
    const bcrypt = require("bcrypt");

    // Parse Excel file
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // Try different parsing approaches to handle various Excel formats
    let jsonData = [];
    try {
      // First try standard JSON conversion (for structured data with headers)
      jsonData = XLSX.utils.sheet_to_json(worksheet);

      // If no data or only one row, try parsing as simple array (for single column without header)
      if (jsonData.length <= 1) {
        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        // Convert the array format to objects with email property
        jsonData = rawData
          .map((row) => {
            // Get the first cell value as email (assuming single column)
            const email = row[0];
            return { email };
          })
          .filter((item) => item.email); // Remove any empty rows
      }
    } catch (error) {
      console.error("Error parsing Excel file:", error);
      return response.status(400).json({
        success: false,
        message: "Error parsing Excel file. Please check the format.",
        error: error.message,
      });
    }

    console.log("Parsed Excel data:", jsonData);

    if (jsonData.length === 0) {
      return response.status(400).json({
        success: false,
        message: "Excel file has no data.",
      });
    }

    // Get the connection to use transaction
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Prepare for results tracking
      const results = {
        successful: [],
        skipped: [],
        failed: [],
      };

      // Default password (hashed)
      const DEFAULT_PASSWORD = "112233";
      const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);

      // Process each row (expected to have an email column/property)
      for (const row of jsonData) {
        // Extract email address - check for various possible column names or formats
        let email;

        if (typeof row === "string") {
          // If the row itself is just a string
          email = row;
        } else if (row.email || row.Email || row.EMAIL) {
          // If it's an object with an email property
          email = row.email || row.Email || row.EMAIL;
        } else if (Object.values(row).length > 0) {
          // Get the first value if it's an object without email property
          email = Object.values(row)[0];
        }

        // Clean the email if it's a string
        if (email && typeof email === "string") {
          email = email.trim();
        }

        if (!email || typeof email !== "string" || !email.includes("@")) {
          results.failed.push({
            email: String(email || "Empty"),
            reason: "Invalid email format",
          });
          continue;
        }

        // Extract first name from email (everything before @)
        const firstName = email.split("@")[0];

        // Check if email already exists FOR THIS CLIENT specifically
        const [existingClientUser] = await connection.query(
          `SELECT * FROM users WHERE email = ? AND client_id = ?`,
          [email, client_id]
        );

        if (existingClientUser.length > 0) {
          results.skipped.push({
            email,
            reason: "Email already registered for this client",
          });
          continue;
        }

        // Create a new client user
        try {
          const uuid = uuidv4();

          // Insert into the users table with appropriate client relationship
          const [insertResult] = await connection.query(
            `INSERT INTO users 
            (uuid, first_name, last_name, email, phone, role, system_role, type, client_id, name, password) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuid,
              firstName,
              "", // empty last name
              email,
              null, // null phone
              "user", // default role
              "client_user", // set system_role to client_user
              "external", // set type to external for client users
              client_id,
              firstName, // name same as first_name
              hashedPassword, // use the hashed default password
            ]
          );

          if (insertResult.affectedRows > 0) {
            results.successful.push({ email, uuid });
          } else {
            results.failed.push({ email, reason: "Database insert failed" });
          }
        } catch (error) {
          console.error(`Error inserting user ${email}:`, error);
          results.failed.push({ email, reason: error.message });
        }
      }

      // Commit the transaction
      await connection.commit();

      // Ensure results arrays are defined
      const formattedResults = {
        total: jsonData.length,
        successful: Array.isArray(results.successful) ? results.successful : [],
        skipped: Array.isArray(results.skipped) ? results.skipped : [],
        failed: Array.isArray(results.failed) ? results.failed : [],
      };

      console.log("Final results to send:", formattedResults);

      return response.status(200).json({
        success: true,
        message: "Users processed successfully.",
        results: formattedResults,
      });
    } catch (error) {
      // Rollback the transaction in case of error
      await connection.rollback();
      console.error("Database error:", error);
      return response.status(500).json({
        success: false,
        message: "Database error occurred while processing users.",
        error: error.message,
        results: {
          total: 0,
          successful: [],
          skipped: [],
          failed: [],
        },
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error processing the file:", error);
    return response.status(500).json({
      success: false,
      message: "An error occurred while processing the file.",
      error: error.message,
      results: {
        total: 0,
        successful: [],
        skipped: [],
        failed: [],
      },
    });
  }
}

const clientController = {
  fetch,
  fetch_client_users,
  get_user,
  update_user,
  delete_user,
  upload_users,
};

module.exports = clientController;
