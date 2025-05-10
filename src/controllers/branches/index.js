const XLSX = require("xlsx");
const fs = require("fs/promises");
const path = require("path");
const db = require("../../database/sql");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const { sendInviteEmail } = require("../email");
const fs2 = require("fs");

async function fetchBranches(request, response) {
  try {
    const { client_id } = request.query;

    if (!client_id) {
      return response.status(400).json({
        message: "client_id is required.",
      });
    }

    // Get a connection from the pool
    const connection = await db.getConnection();

    try {
      // First, get the client name to determine the table name
      const [clientResult] = await connection.query(
        "SELECT name FROM clients WHERE uuid = ?",
        [client_id]
      );

      if (clientResult.length === 0) {
        return response.status(404).json({
          message: "Client not found.",
        });
      }

      const client_name = clientResult[0].name;
      // Format client name to be used in table name (remove spaces, special chars)
      const formattedClientName = client_name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      const dynamicTableName = `${formattedClientName}_branches`;

      // Check if the dynamic table exists
      const [tableExists] = await connection.query(
        `
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = ?
      `,
        [dynamicTableName]
      );

      let rows = [];
      let headers = [];

      if (tableExists[0].count > 0) {
        // If the dynamic table exists, fetch data from it
        console.log(`Fetching data from dynamic table: ${dynamicTableName}`);
        [rows] = await connection.query(
          `SELECT * FROM ${dynamicTableName} WHERE client_id = ?`,
          [client_id]
        );

        // Get table columns to create headers in database-defined order
        const [columnsInfo] = await connection.query(
          `
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()
          AND COLUMN_NAME NOT IN ('id', 'client_id', 'created_at', 'updated_at')
          ORDER BY ORDINAL_POSITION
        `,
          [dynamicTableName]
        );

        // Format headers for frontend
        headers = columnsInfo.map((col) => ({
          field: col.COLUMN_NAME,
          headerName: col.COLUMN_NAME.replace(/_/g, " ").replace(
            /\w\S*/g,
            (txt) => txt.charAt(0).toUpperCase() + txt.substr(1)
          ),
        }));
      } else {
        // Fallback to the legacy branches table if no dynamic table exists
        console.log(
          "Dynamic table does not exist. Falling back to branches table."
        );
        [rows] = await connection.query(
          "SELECT * FROM branches WHERE client_id = ?",
          [client_id]
        );
      }

      return response.status(200).json({
        data: rows,
        headers: headers,
        tableName: tableExists[0].count > 0 ? dynamicTableName : null,
        message: "Branches fetched successfully.",
      });
    } finally {
      // Release the connection back to the pool
      connection.release();
    }
  } catch (error) {
    console.error("Error in fetchBranches:", error);
    return response.status(500).json({
      error: error.message || "An error occurred while fetching branches.",
    });
  }
}

async function createScopes(request, response) {
  try {
    const { client_id, scopes } = request.body;

    if (!client_id || !Array.isArray(scopes)) {
      return response.status(400).json({
        message: "client_id and scopes (array) are required.",
      });
    }

    const connection = await db.getConnection();

    try {
      // Check if any scopes exist for the provided client_id
      const [existingScopes] = await connection.query(
        "SELECT id FROM branch_scopes WHERE client_id = ?",
        [client_id]
      );

      // If scopes exist for the client_id, delete them
      if (existingScopes.length > 0) {
        await connection.query(
          "DELETE FROM branch_scopes WHERE client_id = ?",
          [client_id]
        );
      }

      // Insert new scopes for the client_id
      const scopesData = scopes.map((item) => [
        client_id,
        item.essential,
        item.essential_key,
        item.id,
      ]);

      const [result] = await connection.query(
        "INSERT INTO branch_scopes (client_id, scope, scope_key, essential_id) VALUES ?",
        [scopesData]
      );

      if (result.affectedRows !== scopes.length) {
        throw new Error("Failed to insert all scopes.");
      }

      // Get User Roles
      const [userRoles] = await connection.query("SELECT * FROM user_roles");
      const rolesHeaders = userRoles.map((role) => role.role);
      const scopesHeaders = scopes.map((item) => item.essential);
      const headers = [...scopesHeaders, ...rolesHeaders];

      const worksheet = XLSX.utils.aoa_to_sheet([headers]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Branch Template");

      const [client_rows] = await connection.query(
        "SELECT first_name, last_name FROM clients WHERE uuid = ?",
        [client_id]
      );
      const client_name = `${client_rows[0].first_name}_${client_rows[0].last_name}`;

      // Define the directory and file path for saving the template
      const uploadsDir = path.join(__dirname, "uploads");
      const clientDir = path.join(uploadsDir, client_name);

      await fs.mkdir(clientDir, { recursive: true }); // Ensure the directory exists

      // Generate filename with timestamp
      const timestamp = new Date()
        .toISOString()
        .replace(/[-T:]/g, "_")
        .split(".")[0]; // Format: YYYY_MM_DD_HH_MM_SS

      const fileName = `${client_name}_${timestamp}_branch_template.xlsx`;
      const filePath = path.join(clientDir, fileName);

      // Write the workbook
      XLSX.writeFile(workbook, filePath);

      // Store a **relative path** in the database
      const relativePath = path.relative(uploadsDir, filePath);

      await connection.query(
        "INSERT INTO branch_templates (client_id, template_name, download_url) VALUES (?, ?, ?)",
        [client_id, fileName, relativePath]
      );

      return response.status(200).json({
        message: "Branch scopes created and template uploaded successfully.",
        download_url: relativePath, // Return relative path
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return response.status(500).json({
      error: error.message || "An error occurred.",
    });
  }
}

async function downloadTemplate(request, response) {
  try {
    const { id } = request.params;

    if (!id) {
      return response.status(400).json({ message: "Template ID is required." });
    }

    // Fetch the template details from the database
    const [template] = await db.query(
      "SELECT download_url, template_name FROM branch_templates WHERE id = ?",
      [id]
    );

    if (!template.length) {
      return response.status(404).json({ message: "Template not found." });
    }

    const fileRelativePath = template[0].download_url;
    const fileName = template[0].template_name;

    // Convert relative path to absolute path
    const filePath = path.join(__dirname, "uploads", fileRelativePath);

    // Check if the file exists
    if (!fs2.existsSync(filePath)) {
      return response.status(404).json({
        message: "File not found.",
        filePath, // Debugging info
      });
    }

    // Send the file for download
    return response.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Error downloading file:", err);
        return response
          .status(500)
          .json({ message: "Error downloading file." });
      }
    });
  } catch (error) {
    return response.status(500).json({
      error: error.message || "An error occurred while downloading the file.",
    });
  }
}

async function regenerateTemplate(request, response) {
  try {
    const { client_id, scopes } = request.body;

    if (!client_id || !Array.isArray(scopes)) {
      return response.status(400).json({
        message: "client_id and scopes (array) are required.",
      });
    }

    const connection = await db.getConnection();

    try {
      // Get User Roles
      const [userRoles] = await connection.query("SELECT * FROM user_roles");

      const rolesHeaders = userRoles.map((role) => role.role);
      const scopesHeaders = scopes.map((item) => item.scope);

      const mediaHeaders = ["Video", "Audio", "Pictures"];
      const headers = [...scopesHeaders, ...mediaHeaders, ...rolesHeaders];

      const worksheet = XLSX.utils.aoa_to_sheet([headers]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Branch Template");

      //Get Client
      const [client_rows] = await connection.query(
        "SELECT first_name, last_name FROM clients WHERE uuid = ?",
        [client_id]
      );
      const client_name = `${client_rows[0].first_name}_${client_rows[0].last_name}`;

      // Define the directory and file path for saving the template
      const clientDir = path.join(__dirname, "uploads", client_name);
      await fs.mkdir(clientDir, { recursive: true }); // Ensure the directory exists

      const now = new Date();

      // Extract components
      let hours = now.getHours();
      const minutes = now.getMinutes().toString().padStart(2, "0");
      const seconds = now.getSeconds().toString().padStart(2, "0");

      // Determine AM or PM
      const meridian = hours >= 12 ? "PM" : "AM";

      // Convert hours to 12-hour format
      hours = hours % 12 || 12; // Ensure hour 0 becomes 12

      const dateTimeString = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${hours
        .toString()
        .padStart(2, "0")}-${minutes}-${seconds} ${meridian}`;

      const fileName = `${client_name}_${dateTimeString}_branch_template.xlsx`;
      const filePath = path.join(clientDir, fileName);

      // Write the workbook and ensure the operation completes successfully
      XLSX.writeFile(workbook, filePath);

      // Generate a relative path
      const uploadsDir = path.join(__dirname, "uploads");
      const relativePath = path.relative(uploadsDir, filePath);

      // Save the template name and download URL in the database
      await connection.query(
        "INSERT INTO branch_templates (client_id, template_name, download_url) VALUES (?, ?, ?)",
        [client_id, fileName, relativePath]
      );

      // Return the public download URL in the response
      return response.status(200).json({
        message: "Branch template regenerated successfully.",
        download_url: relativePath,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return response.status(500).json({
      error: error.message || "An error occurred.",
    });
  }
}

async function fetchTemplates(request, response) {
  try {
    console.log("Fetching branch templates...");
    const { client_id } = request.query;
    console.log("Client ID:", client_id);

    if (!client_id) {
      return response.status(400).json({
        message: "client_id is required.",
      });
    }

    // Get a connection from the pool
    const connection = await db.getConnection();

    try {
      console.log("Querying database for templates...");
      const [rows] = await connection.query(
        "SELECT * FROM branch_templates WHERE client_id = ? ORDER BY created_at DESC",
        [client_id]
      );
      console.log("Templates found:", rows.length);

      return response.status(200).json({
        data: rows,
        message: "Branch templates fetched successfully.",
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error in fetchTemplates:", error);
    return response.status(500).json({
      error: error.message || "An error occurred while fetching templates.",
    });
  }
}

async function deleteTemplate(request, response) {
  try {
    const { client_id, template_id } = request.query;

    if (!client_id || !template_id) {
      return response.status(400).json({
        message: "client_id and template_id are required.",
      });
    }

    const connection = await db.getConnection();

    try {
      // Find the template to get its file path
      const [template] = await connection.query(
        "SELECT download_url FROM branch_templates WHERE id = ? AND client_id = ?",
        [template_id, client_id]
      );

      if (template.length === 0) {
        return response.status(404).json({
          message: "Template not found.",
        });
      }

      // Delete the template from the database
      await connection.query(
        "DELETE FROM branch_templates WHERE id = ? AND client_id = ?",
        [template_id, client_id]
      );

      // Try to delete the file
      try {
        const filePath = path.join(
          __dirname,
          "uploads",
          template[0].download_url
        );
        await fs.unlink(filePath);
      } catch (fileError) {
        console.error("Error deleting file:", fileError);
        // Continue execution even if file deletion fails
      }

      return response.status(200).json({
        message: "Template deleted successfully.",
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    return response.status(500).json({
      error: error.message || "An error occurred while deleting the template.",
    });
  }
}

async function readScopesData(request, response) {
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

    const connection = await db.getConnection();

    try {
      // Get client name first
      const [clientResult] = await connection.query(
        "SELECT name FROM clients WHERE uuid = ?",
        [client_id]
      );

      if (clientResult.length === 0) {
        return response.status(404).json({
          message: "Client not found.",
        });
      }

      const client_name = clientResult[0].name;
      // Format client name to be used in table name (remove spaces, special chars)
      const formattedClientName = client_name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      const dynamicTableName = `${formattedClientName}_branches`;

      console.log(`Creating/accessing dynamic table: ${dynamicTableName}`);

      // Parse Excel file
      const workbook = XLSX.read(fileBuffer, { type: "buffer" });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);
      const rawHeaders = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0];

      if (!rawHeaders || rawHeaders.length === 0) {
        return response.status(400).json({
          success: false,
          message: "Excel file has no headers.",
        });
      }

      // Extract headers for table creation and frontend display
      // Preserve the original order of headers as they appear in the Excel file
      const headers = rawHeaders.map((header, index) => ({
        field: header.toLowerCase().replace(/[^a-z0-9]/g, "_"),
        headerName: header,
        // Add original position to ensure order is preserved
        originalPosition: index,
      }));

      // Create column definitions for SQL table
      const columnDefinitions = rawHeaders
        .map((header) => {
          // Convert header to valid column name (remove spaces, special chars)
          const columnName = header.toLowerCase().replace(/[^a-z0-9]/g, "_");
          return `${columnName} TEXT`;
        })
        .join(", ");

      // Check if table exists, if not create it
      const [tableExists] = await connection.query(
        `
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = ?
      `,
        [dynamicTableName]
      );

      if (tableExists[0].count === 0) {
        console.log(`Table ${dynamicTableName} does not exist. Creating it...`);
        await connection.query(`
          CREATE TABLE ${dynamicTableName} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            client_id VARCHAR(255) NOT NULL,
            ${columnDefinitions},
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        console.log(`Table ${dynamicTableName} created successfully.`);
      } else {
        console.log(`Table ${dynamicTableName} already exists.`);

        // Delete existing data for this client to avoid duplication
        console.log(
          `Clearing existing data for client ${client_id} in table ${dynamicTableName}...`
        );
        await connection.query(
          `DELETE FROM ${dynamicTableName} WHERE client_id = ?`,
          [client_id]
        );
        console.log(`Existing data cleared successfully.`);
      }

      // Insert data into the dynamic table
      const insertedData = [];

      // Create bulk insert query
      for (const row of jsonData) {
        const columnNames = Object.keys(row);
        const columnValues = Object.values(row);

        // Format column names for SQL (remove spaces, special chars)
        const formattedColumnNames = columnNames.map((name) =>
          name.toLowerCase().replace(/[^a-z0-9]/g, "_")
        );

        // Build the column part of the SQL query
        const columnsSQL = ["client_id", ...formattedColumnNames].join(", ");

        // Build the placeholders for values
        const placeholders = Array(formattedColumnNames.length + 1)
          .fill("?")
          .join(", ");

        // Insert the row
        const [result] = await connection.query(
          `INSERT INTO ${dynamicTableName} (${columnsSQL}) VALUES (${placeholders})`,
          [client_id, ...columnValues]
        );

        // Store inserted data for response with original column names
        const rowWithId = { id: result.insertId, client_id, ...row };
        insertedData.push(rowWithId);
      }

      // Return successfully processed data
      return response.status(200).json({
        success: true,
        message: `Data processed and inserted successfully into ${dynamicTableName}.`,
        data: insertedData,
        headers: headers,
        tableName: dynamicTableName,
      });
    } catch (error) {
      console.error("Database error:", error);
      return response.status(500).json({
        success: false,
        message: "Database error occurred while processing data.",
        error: error.message,
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
    });
  }
}

// Add this function to download branch data as Excel
async function downloadBranchData(request, response) {
  try {
    const { client_id } = request.query;

    if (!client_id) {
      return response.status(400).json({
        message: "client_id is required.",
      });
    }

    // Get a connection from the pool
    const connection = await db.getConnection();

    try {
      // First, get the client name to determine the table name
      const [clientResult] = await connection.query(
        "SELECT name FROM clients WHERE uuid = ?",
        [client_id]
      );

      if (clientResult.length === 0) {
        return response.status(404).json({
          message: "Client not found.",
        });
      }

      const client_name = clientResult[0].name;
      // Format client name to be used in table name (remove spaces, special chars)
      const formattedClientName = client_name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      const dynamicTableName = `${formattedClientName}_branches`;

      // Check if the dynamic table exists
      const [tableExists] = await connection.query(
        `
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = ?
      `,
        [dynamicTableName]
      );

      if (tableExists[0].count === 0) {
        return response.status(404).json({
          message: "No data found for this client.",
        });
      }

      // Get data from the table
      const [rows] = await connection.query(
        `SELECT * FROM ${dynamicTableName} WHERE client_id = ?`,
        [client_id]
      );

      if (rows.length === 0) {
        return response.status(404).json({
          message: "No data found for this client.",
        });
      }

      // Get column names (excluding internal ones)
      const [columnsInfo] = await connection.query(
        `
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()
        AND COLUMN_NAME NOT IN ('id', 'client_id', 'created_at', 'updated_at')
        ORDER BY ORDINAL_POSITION
      `,
        [dynamicTableName]
      );

      const columnNames = columnsInfo.map((col) => col.COLUMN_NAME);

      // Convert data to more friendly format for Excel
      const excelData = rows.map((row) => {
        const excelRow = {};
        columnNames.forEach((col) => {
          // Convert snake_case to Title Case for headers
          const friendlyHeader = col
            .replace(/_/g, " ")
            .replace(
              /\w\S*/g,
              (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
            );
          excelRow[friendlyHeader] = row[col];
        });
        return excelRow;
      });

      // Create a worksheet
      const worksheet = XLSX.utils.json_to_sheet(excelData);

      // Create workbook and add the worksheet
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Branch Data");

      // Generate file name
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `${client_name}_branch_data_${timestamp}.xlsx`;

      // Create a temp path for the file
      const tempPath = path.join(__dirname, "temp");
      await fs.mkdir(tempPath, { recursive: true });
      const filePath = path.join(tempPath, fileName);

      // Write the workbook to a file
      XLSX.writeFile(workbook, filePath);

      // Send the file as a download
      response.download(filePath, fileName, (err) => {
        if (err) {
          console.error("Error sending file:", err);
          return response.status(500).json({
            message: "Error sending file.",
          });
        }

        // Delete the temporary file after sending
        fs.unlink(filePath).catch((err) => {
          console.error("Error deleting temporary file:", err);
        });
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error in downloadBranchData:", error);
    return response.status(500).json({
      error:
        error.message || "An error occurred while downloading branch data.",
    });
  }
}

async function addBranch(request, response) {
  try {
    const branchData = request.body;
    const { client_id } = branchData;

    if (!client_id) {
      return response.status(400).json({
        message: "Client ID is required.",
      });
    }

    // Get a connection from the pool
    const connection = await db.getConnection();

    try {
      // First, get the client name to determine the table name
      const [clientResult] = await connection.query(
        "SELECT name FROM clients WHERE uuid = ?",
        [client_id]
      );

      if (clientResult.length === 0) {
        return response.status(404).json({
          message: "Client not found.",
        });
      }

      const client_name = clientResult[0].name;
      // Format client name to be used in table name (remove spaces, special chars)
      const formattedClientName = client_name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      const dynamicTableName = `${formattedClientName}_branches`;

      // Check if the dynamic table exists
      const [tableExists] = await connection.query(
        `
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = ?
      `,
        [dynamicTableName]
      );

      if (tableExists[0].count > 0) {
        // Generate a UUID for the branch
        branchData.uuid = uuidv4();

        // Get table columns to create dynamic insert query
        const [columnsInfo] = await connection.query(
          `
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE()
          AND COLUMN_NAME NOT IN ('id', 'created_at', 'updated_at')
          ORDER BY ORDINAL_POSITION
        `,
          [dynamicTableName]
        );

        // Filter out keys that don't match column names
        const validColumns = columnsInfo.map((col) => col.COLUMN_NAME);
        const filteredData = {};

        for (const key in branchData) {
          if (validColumns.includes(key)) {
            filteredData[key] = branchData[key];
          }
        }

        // Add client_id if it's a valid column and ensure uuid is included
        if (validColumns.includes("client_id")) {
          filteredData.client_id = client_id;
        }
        if (validColumns.includes("uuid")) {
          filteredData.uuid = branchData.uuid;
        }

        // Build the dynamic insert query
        const columns = Object.keys(filteredData);
        const placeholders = columns.map(() => "?").join(", ");
        const values = Object.values(filteredData);

        const query = `INSERT INTO ${dynamicTableName} (${columns.join(
          ", "
        )}) VALUES (${placeholders})`;

        // Execute the query
        const [result] = await connection.query(query, values);

        return response.status(200).json({
          message: "Branch added successfully.",
          branch_id: branchData.uuid,
          data: filteredData,
        });
      } else {
        // If no dynamic table exists, create a branch in the default branches table
        const uuid = uuidv4();

        const [result] = await connection.query(
          `INSERT INTO branches 
          (uuid, branch_name, branch_code, email, phone, region, zone, address, city, country, client_id) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuid,
            branchData.branch_name || null,
            branchData.branch_code || null,
            branchData.email || null,
            branchData.phone || null,
            branchData.region || null,
            branchData.zone || null,
            branchData.address || null,
            branchData.city || null,
            branchData.country || null,
            client_id,
          ]
        );

        return response.status(200).json({
          message: "Branch added successfully to default table.",
          branch_id: uuid,
          data: {
            ...branchData,
            uuid,
          },
        });
      }
    } finally {
      // Release the connection back to the pool
      connection.release();
    }
  } catch (error) {
    console.error("Error in addBranch:", error);
    return response.status(500).json({
      error: error.message || "An error occurred while adding the branch.",
    });
  }
}

/**
 * Delete a branch from the client's branch table
 */
async function deleteBranch(request, response) {
  try {
    const { client_id, branch_id } = request.query;

    if (!client_id || !branch_id) {
      return response.status(400).json({
        message: "client_id and branch_id are required.",
      });
    }

    // Get a connection from the pool
    const connection = await db.getConnection();

    try {
      // First, get the client name to determine the table name
      const [clientResult] = await connection.query(
        "SELECT name FROM clients WHERE uuid = ?",
        [client_id]
      );

      if (clientResult.length === 0) {
        return response.status(404).json({
          message: "Client not found.",
        });
      }

      const client_name = clientResult[0].name;
      // Format client name to be used in table name (remove spaces, special chars)
      const formattedClientName = client_name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      const dynamicTableName = `${formattedClientName}_branches`;

      // Check if the dynamic table exists
      const [tableExists] = await connection.query(
        `
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_name = ?
      `,
        [dynamicTableName]
      );

      if (tableExists[0].count > 0) {
        // If the dynamic table exists, delete the branch from it
        console.log(`Deleting branch from dynamic table: ${dynamicTableName}`);
        const [deleteResult] = await connection.query(
          `DELETE FROM ${dynamicTableName} WHERE id = ? AND client_id = ?`,
          [branch_id, client_id]
        );

        if (deleteResult.affectedRows === 0) {
          return response.status(404).json({
            message: "Branch not found or already deleted.",
          });
        }
      } else {
        // Fallback to the legacy branches table if no dynamic table exists
        console.log(
          "Dynamic table does not exist. Falling back to branches table."
        );
        const [deleteResult] = await connection.query(
          "DELETE FROM branches WHERE id = ? AND client_id = ?",
          [branch_id, client_id]
        );

        if (deleteResult.affectedRows === 0) {
          return response.status(404).json({
            message: "Branch not found or already deleted.",
          });
        }
      }

      return response.status(200).json({
        message: "Branch deleted successfully.",
      });
    } finally {
      // Release the connection back to the pool
      connection.release();
    }
  } catch (error) {
    console.error("Error in deleteBranch:", error);
    return response.status(500).json({
      error: error.message || "An error occurred while deleting the branch.",
    });
  }
}

const branchController = {
  fetchBranches,
  readScopesData,
  createScopes,
  downloadTemplate,
  regenerateTemplate,
  fetchTemplates,
  deleteTemplate,
  downloadBranchData,
  addBranch,
  deleteBranch,
};

module.exports = branchController;
