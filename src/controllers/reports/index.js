const db = require("../../database/sql");
const {
  trackUserPerformance,
  calculateReportTime,
} = require("./user_performance");

/**
 * Save a report
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const saveReport = async (req, res) => {
  try {
    const {
      client_id,
      template_name,
      colors,
      content,
      status,
      user_id: requestUserId,
      id: bodyId, // Allow ID to be passed in the body
      table, // Allow table to be specified in the body
      media_links, // Extract media links from request
      visits_add, // Extract the visits_add flag from request body
    } = req.body;
    // console.log("content", req.body);

    // Check if this is an update request (PUT) by checking for ID in URL params
    const reportId = req.params.id || bodyId;
    const isUpdate = !!reportId;

    // Use user_id from request payload if provided, otherwise fall back to JWT token
    const user_id = requestUserId || req.user?.id || null;

    // console.log(
    //   "User ID for report creation/update:",
    //   user_id,
    //   "Request payload ID:",
    //   requestUserId,
    //   "JWT token ID:",
    //   req.user?.id
    // );

    // console.log(
    //   "Report operation:",
    //   isUpdate ? "UPDATE" : "CREATE",
    //   "Report ID:",
    //   reportId,
    //   "Table:",
    //   table
    // );

    if (!client_id || !template_name) {
      return res.status(400).json({
        error: "Client ID and template name are required",
      });
    }

    // console.log("Attempting to save report with client_id:", client_id);
    // console.log("Report template name:", template_name);

    // Default status to 'draft' if not provided
    const reportStatus = status || "draft";

    // If updating and table is provided in the query, use it
    const tableFromQuery = req.query.table;
    const clientReportsTableOverride = tableFromQuery || table;

    // Get a connection from the pool
    const connection = await db.getConnection();

    try {
      // First, get the client name for the table name
      // console.log("Executing client lookup query for ID:", client_id);

      // Try to normalize UUID format if needed
      let normalizedClientId = client_id;
      if (typeof client_id === "string" && client_id.includes("-")) {
        // Keep UUID format as is for lookup
        normalizedClientId = client_id;
      }

      const [clientResult] = await connection.query(
        "SELECT id, name FROM clients WHERE id = ?",
        [normalizedClientId]
      );

      // console.log("Client lookup result:", clientResult);

      if (clientResult.length === 0) {
        // Try alternative lookup if using UUID string
        // console.log(
        //   "Client not found with primary lookup, trying alternative lookup"
        // );
        const [altClientResult] = await connection.query(
          "SELECT id, name FROM clients WHERE uuid = ?",
          [client_id]
        );

        console.log("Alternative client lookup result:", altClientResult);

        if (altClientResult.length === 0) {
          return res.status(404).json({
            error: "Client not found. Tried with ID: " + client_id,
          });
        }

        // Use client from alternative lookup
        clientResult[0] = altClientResult[0];
      }

      // Format client name to be used in table name (remove spaces, special chars)
      const clientName = clientResult[0].name
        .replace(/\s+/g, "_") // Replace spaces with underscores
        .replace(/[^a-zA-Z0-9_]/g, "") // Remove special characters
        .toLowerCase();

      // Define the client-specific reports table name
      // If directly updating with a specific table, use that instead
      const clientReportsTable =
        clientReportsTableOverride || `${clientName}_reports`;
      console.log("Using client table name:", clientReportsTable);

      // Extract primary field information from the content
      let primaryFieldName = "branch_code"; // Default to branch_code
      let primaryFieldValue = null;

      // Check if content has a specific primaryField object (new format)
      if (content && typeof content === "object" && content.primaryField) {
        primaryFieldName = content.primaryField.name;
        primaryFieldValue = content.primaryField.value;
        // console.log(
        //   `Using primaryField from content: ${primaryFieldName} = ${primaryFieldValue}`
        // );
      }
      // Fallback to the old method if primaryField is not directly available
      else if (
        content &&
        typeof content === "object" &&
        content.primaryIdentifierField &&
        content.selectedFieldValues
      ) {
        primaryFieldName = content.primaryIdentifierField;

        // Get the value for the primary field
        const primaryFieldObj = content.selectedFieldValues[primaryFieldName];
        if (primaryFieldObj) {
          // If it's an object with value property (from dropdown)
          if (typeof primaryFieldObj === "object" && primaryFieldObj.value) {
            primaryFieldValue = primaryFieldObj.value;
          } else if (
            typeof primaryFieldObj === "object" &&
            primaryFieldObj.name
          ) {
            primaryFieldValue = primaryFieldObj.name;
          } else {
            primaryFieldValue = primaryFieldObj;
          }
        }

        // console.log(
        //   `Using dynamic primary field: ${primaryFieldName} = ${primaryFieldValue}`
        // );
      } else {
        // console.log(
        //   "No primary field defined in content, using default primary field name"
        // );
      }

      // Handle the visits_add flag for visit numbering
      // If visits_add is true, add a visit number suffix to the primary field value
      if (visits_add === true && primaryFieldValue) {
        // console.log("Visits add enabled, checking for existing visits...");

        // Check if table exists before querying
        const [tableCheck] = await connection.query(
          "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
          [clientReportsTable]
        );

        // Only proceed with visit numbering if the table exists
        if (tableCheck[0].count > 0) {
          // Query existing reports with the same primary field value pattern
          const [existingVisits] = await connection.query(
            `SELECT primary_field_value FROM ${clientReportsTable} 
            WHERE primary_field_name = ? AND primary_field_value LIKE ?`,
            [primaryFieldName, `${primaryFieldValue}-visit-%`]
          );

          // console.log(
          //   `Found ${existingVisits.length} existing visits for ${primaryFieldValue}`
          // );

          // Find the highest visit number
          let maxVisitNumber = 0;
          existingVisits.forEach((report) => {
            const match = report.primary_field_value.match(/-visit-(\d+)$/);
            if (match && match[1]) {
              const visitNumber = parseInt(match[1], 10);
              if (!isNaN(visitNumber) && visitNumber > maxVisitNumber) {
                maxVisitNumber = visitNumber;
              }
            }
          });

          // Append visit number to primary field value
          primaryFieldValue = `${primaryFieldValue}-visit-${
            maxVisitNumber + 1
          }`;
          // console.log(
          //   `Using visit-numbered primary field value: ${primaryFieldValue}`
          // );
        } else {
          // If table doesn't exist yet, this is the first report, so use visit-1
          primaryFieldValue = `${primaryFieldValue}-visit-1`;
          // console.log(
          //   `First report for this client, using: ${primaryFieldValue}`
          // );
        }
      }

      // If this is a direct update to a specific report ID (PUT request)
      if (isUpdate && reportId) {
        // Check if the table exists
        const [tableExists] = await connection.query(
          "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
          [clientReportsTable]
        );

        if (tableExists[0].count === 0) {
          return res.status(404).json({
            error: `Table ${clientReportsTable} does not exist`,
          });
        }

        // Check if the report exists in the table
        const [reportExists] = await connection.query(
          `SELECT id FROM ${clientReportsTable} WHERE id = ?`,
          [reportId]
        );

        if (reportExists.length === 0) {
          return res.status(404).json({
            error: `Report with ID ${reportId} not found in table ${clientReportsTable}`,
          });
        }

        // Update the existing report
        console.log(
          `Directly updating report with ID: ${reportId} in table: ${clientReportsTable}`
        );

        // Extract timestamp_url from the request for updates
        const timestamp_url = req.body.timestamp_url || null;
        console.log("Timestamp URL for update:", timestamp_url);

        await connection.query(
          `UPDATE ${clientReportsTable} 
           SET primary_field_name = ?, primary_field_value = ?, colors = ?, content = ?, status = ?, updated_by = ?, updated_at = NOW(), template_name = ?,
           video_url = ?, audio_url = ?, images_urls = ?, timestamp_url = ? 
           WHERE id = ?`,
          [
            primaryFieldName,
            primaryFieldValue,
            JSON.stringify(colors || {}),
            JSON.stringify(content || {}),
            reportStatus,
            user_id,
            template_name,
            media_links?.video_link || null,
            media_links?.audio_link || null,
            media_links?.image_link
              ? JSON.stringify([media_links.image_link])
              : null,
            timestamp_url,
            reportId,
          ]
        );

        // Track user performance
        try {
          // Get the report start time - either from the existing record or use a default (30 mins ago)
          let reportStartTime = new Date();
          reportStartTime.setMinutes(reportStartTime.getMinutes() - 30); // Default 30 mins ago

          // For updates, try to get the previous update time
          const [existingReport] = await connection.query(
            `SELECT updated_at FROM ${clientReportsTable} WHERE id = ?`,
            [reportId]
          );

          if (existingReport.length > 0) {
            reportStartTime =
              existingReport[0].updated_at || existingReport[0].created_at;
          }

          // Try to extract elapsed time from content
          let elapsedTimeInSeconds = 0;

          if (content && typeof content === "object") {
            // Try to extract elapsedTimeSeconds from timerInfo first (new format)
            if (content.timerInfo && content.timerInfo.elapsedTimeSeconds) {
              elapsedTimeInSeconds = content.timerInfo.elapsedTimeSeconds;
              // console.log(
              //   `Found elapsedTimeSeconds in timerInfo: ${elapsedTimeInSeconds} seconds`
              // );
            }
            // Try to extract elapsedTimeSeconds directly
            else if (content.elapsedTimeSeconds) {
              elapsedTimeInSeconds = content.elapsedTimeSeconds;
              // console.log(
              //   `Found elapsedTimeSeconds in content: ${elapsedTimeInSeconds} seconds`
              // );
            }
            // Also look for it in nested structures
            else if (
              content.reportInfo &&
              content.reportInfo.elapsedTimeSeconds
            ) {
              elapsedTimeInSeconds = content.reportInfo.elapsedTimeSeconds;
              console.log(
                `Found elapsedTimeSeconds in reportInfo: ${elapsedTimeInSeconds} seconds`
              );
            }
            // Try other possible locations
            else if (content.metadata && content.metadata.elapsedTimeSeconds) {
              elapsedTimeInSeconds = content.metadata.elapsedTimeSeconds;
              console.log(
                `Found elapsedTimeSeconds in metadata: ${elapsedTimeInSeconds} seconds`
              );
            }
          }

          let reportTime;
          // If we found elapsed time in seconds in the content, use that
          if (elapsedTimeInSeconds > 0) {
            // Convert seconds to minutes for storage, with minimum of 1 minute
            reportTime = Math.max(1, Math.round(elapsedTimeInSeconds / 60));
            console.log(
              `Converting ${elapsedTimeInSeconds} seconds to ${reportTime} minutes for report_time in update flow`
            );
          } else {
            // Fall back to calculated time based on timestamps
            reportTime = calculateReportTime(reportStartTime, new Date());
            console.log(
              `Using calculated report time: ${reportTime} minutes (from timestamps)`
            );
          }

          // Get the current timestamp
          const reportCreationTime = new Date();

          // Track the performance
          await trackUserPerformance({
            client_id: clientResult[0].id, // Use numeric client ID
            user_id: user_id,
            report_id: reportId,
            report_name: template_name,
            report_time: reportTime,
            creation_timestamp: reportCreationTime,
            elapsed_seconds: elapsedTimeInSeconds,
            status: reportStatus,
            score: null, // Score will be added later when implemented
          });
        } catch (perfError) {
          // Non-blocking - log but don't fail the request
          console.error("Error tracking user performance:", perfError);
        }

        return res.status(200).json({
          success: true,
          message: `Report with ID ${reportId} updated successfully in ${clientReportsTable}`,
          data: {
            id: reportId,
            table: clientReportsTable,
            primary_field: {
              name: primaryFieldName,
              value: primaryFieldValue,
            },
            timestamp_url: timestamp_url,
          },
        });
      }

      // Continue with normal flow for non-direct updates...
      // Check if the client-specific table exists
      const [tableExists] = await connection.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [clientReportsTable]
      );

      if (tableExists[0].count === 0) {
        console.log(`Creating new table for client: ${clientReportsTable}`);

        // Create the client-specific reports table with dynamic primary field
        await connection.query(`
          CREATE TABLE ${clientReportsTable} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            client_id VARCHAR(255) NOT NULL,
            template_name VARCHAR(255) NOT NULL,
            primary_field_name VARCHAR(100) NOT NULL,
            primary_field_value VARCHAR(255),
            colors JSON,
            content JSON,
            status VARCHAR(50) DEFAULT 'draft',
            created_by INT DEFAULT NULL,
            updated_by INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            video_url TEXT DEFAULT NULL,
            audio_url TEXT DEFAULT NULL,
            images_urls JSON DEFAULT NULL,
            timestamp_url TEXT DEFAULT NULL
          )
        `);
      } else {
        // Check if the primary_field_name column exists
        const [checkPrimaryFieldName] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'primary_field_name'
        `,
          [clientReportsTable]
        );

        // Check if the primary_field_value column exists
        const [checkPrimaryFieldValue] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'primary_field_value'
        `,
          [clientReportsTable]
        );

        // After the existing column checks, add checks for the media URL columns
        // Check if the video_url column exists
        const [checkVideoUrl] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'video_url'
        `,
          [clientReportsTable]
        );

        // Check if the audio_url column exists
        const [checkAudioUrl] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'audio_url'
        `,
          [clientReportsTable]
        );

        // Check if the images_urls column exists
        const [checkImagesUrls] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'images_urls'
        `,
          [clientReportsTable]
        );

        // Check if timestamp_url column exists
        const [checkTimestampUrl] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'timestamp_url'
        `,
          [clientReportsTable]
        );

        // Add primary_field_name column if it doesn't exist
        if (checkPrimaryFieldName[0].count === 0) {
          await connection.query(`
            ALTER TABLE ${clientReportsTable}
            ADD COLUMN primary_field_name VARCHAR(100) NOT NULL DEFAULT 'branch_code'
          `);
        }

        // Add primary_field_value column if it doesn't exist
        if (checkPrimaryFieldValue[0].count === 0) {
          await connection.query(`
            ALTER TABLE ${clientReportsTable}
            ADD COLUMN primary_field_value VARCHAR(255)
          `);
        }

        // Add video_url column if it doesn't exist
        if (checkVideoUrl[0].count === 0) {
          await connection.query(`
            ALTER TABLE ${clientReportsTable}
            ADD COLUMN video_url TEXT DEFAULT NULL
          `);
        }

        // Add audio_url column if it doesn't exist
        if (checkAudioUrl[0].count === 0) {
          await connection.query(`
            ALTER TABLE ${clientReportsTable}
            ADD COLUMN audio_url TEXT DEFAULT NULL
          `);
        }

        // Add images_urls column if it doesn't exist
        if (checkImagesUrls[0].count === 0) {
          await connection.query(`
            ALTER TABLE ${clientReportsTable}
            ADD COLUMN images_urls JSON DEFAULT NULL
          `);
        }

        // Add timestamp_url column if it doesn't exist
        if (checkTimestampUrl[0].count === 0) {
          await connection.query(`
            ALTER TABLE ${clientReportsTable}
            ADD COLUMN timestamp_url TEXT DEFAULT NULL
          `);
        }

        // Check if branch_code column exists and copy values if needed
        const [branchCodeCheck] = await connection.query(
          `
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE 
            table_schema = DATABASE() 
            AND table_name = ? 
            AND column_name = 'branch_code'
        `,
          [clientReportsTable]
        );

        // If branch_code exists, copy values to primary_field_value for backward compatibility
        if (branchCodeCheck[0].count > 0) {
          await connection.query(`
            UPDATE ${clientReportsTable}
            SET primary_field_value = branch_code
            WHERE primary_field_value IS NULL AND branch_code IS NOT NULL
          `);
        }
      }

      // First check if a report with the exact same template name already exists
      const [existingByName] = await connection.query(
        `SELECT id FROM ${clientReportsTable} WHERE client_id = ? AND template_name = ?`,
        [client_id, template_name]
      );

      // If this is a direct update with ID specified (PUT request), update the existing report
      if (isUpdate && reportId) {
        // This case is already handled above
        // Just left here for clarity of logic flow
      }
      // For regular POST requests (new reports)
      else {
        // Check for existing reports with the same primary field value
        if (primaryFieldValue) {
          // Get all reports with the same primary field name and value (or similar with -1, -2 suffixes)
          const [similarReports] = await connection.query(
            `SELECT primary_field_value FROM ${clientReportsTable} 
             WHERE client_id = ? AND primary_field_name = ? AND (primary_field_value = ? OR primary_field_value LIKE ?)`,
            [
              client_id,
              primaryFieldName,
              primaryFieldValue,
              `${primaryFieldValue}-%`,
            ]
          );

          // If there are similar reports, always add a suffix instead of updating
          if (similarReports.length > 0) {
            console.log(
              `Found ${similarReports.length} similar reports with the primary field ${primaryFieldName}`
            );

            // Get the highest suffix number
            let maxSuffix = 0;
            let basePrimaryValue = primaryFieldValue;
            let hasSuffix = false;

            similarReports.forEach((report) => {
              // Check if this exact value already exists (without suffix)
              if (report.primary_field_value === primaryFieldValue) {
                hasSuffix = true; // Mark that we need a suffix
              }

              // Handle values with dash and number suffix like "ABC-1", "ABC-2"
              if (report.primary_field_value.includes("-")) {
                const parts = report.primary_field_value.split("-");
                const lastPart = parts[parts.length - 1];
                const suffix = parseInt(lastPart);

                // If the base value matches and the suffix is a number
                if (
                  !isNaN(suffix) &&
                  report.primary_field_value.startsWith(`${basePrimaryValue}-`)
                ) {
                  if (suffix > maxSuffix) {
                    maxSuffix = suffix;
                  }
                }
              }
            });

            // If an exact match exists or we have suffixed versions, add/increment suffix
            if (hasSuffix || maxSuffix > 0) {
              primaryFieldValue = `${basePrimaryValue}-${maxSuffix + 1}`;
              console.log(
                `Creating new report with incremented primary field value: ${primaryFieldValue}`
              );

              // Update the content object to reflect the new primary field value
              if (content && typeof content === "object") {
                if (content.primaryField) {
                  content.primaryField.value = primaryFieldValue;
                } else if (
                  content.selectedFieldValues &&
                  content.primaryIdentifierField
                ) {
                  // Update in the old format as well if needed
                  const fieldName = content.primaryIdentifierField;
                  if (content.selectedFieldValues[fieldName]) {
                    if (
                      typeof content.selectedFieldValues[fieldName] === "object"
                    ) {
                      content.selectedFieldValues[fieldName].value =
                        primaryFieldValue;
                    } else {
                      content.selectedFieldValues[fieldName] =
                        primaryFieldValue;
                    }
                  }
                }
              }
            }
          }
        }

        // Always create a new report (with incremented suffix if needed)
        console.log(
          "Creating new report with primary field value:",
          primaryFieldValue
        );

        // Extract timestamp_url from the request
        const timestamp_url = req.body.timestamp_url || null;
        console.log("Timestamp URL from request:", timestamp_url);

        const [result] = await connection.query(
          `INSERT INTO ${clientReportsTable} 
           (client_id, template_name, primary_field_name, primary_field_value, colors, content, status, created_by, updated_by, video_url, audio_url, images_urls, timestamp_url) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            client_id,
            template_name,
            primaryFieldName,
            primaryFieldValue,
            JSON.stringify(colors || {}),
            JSON.stringify(content || {}),
            reportStatus,
            user_id,
            user_id,
            media_links?.video_link || null,
            media_links?.audio_link || null,
            media_links?.image_link
              ? JSON.stringify([media_links.image_link])
              : null,
            timestamp_url,
          ]
        );

        // Track user performance
        try {
          // For new reports, use the actual creation timestamp
          const reportCreationTime = new Date(); // Current time when report is created

          // Try to extract elapsed time from content
          let elapsedTimeInSeconds = 0;

          if (content && typeof content === "object") {
            // Try to extract elapsedTimeSeconds from timerInfo first (new format)
            if (content.timerInfo && content.timerInfo.elapsedTimeSeconds) {
              elapsedTimeInSeconds = content.timerInfo.elapsedTimeSeconds;
              console.log(
                `Found elapsedTimeSeconds in timerInfo: ${elapsedTimeInSeconds} seconds`
              );
            }
            // Try to extract elapsedTimeSeconds directly
            else if (content.elapsedTimeSeconds) {
              elapsedTimeInSeconds = content.elapsedTimeSeconds;
              console.log(
                `Found elapsedTimeSeconds in content: ${elapsedTimeInSeconds} seconds`
              );
            }
            // Also look for it in nested structures
            else if (
              content.reportInfo &&
              content.reportInfo.elapsedTimeSeconds
            ) {
              elapsedTimeInSeconds = content.reportInfo.elapsedTimeSeconds;
              console.log(
                `Found elapsedTimeSeconds in reportInfo: ${elapsedTimeInSeconds} seconds`
              );
            }
            // Try other possible locations
            else if (content.metadata && content.metadata.elapsedTimeSeconds) {
              elapsedTimeInSeconds = content.metadata.elapsedTimeSeconds;
              console.log(
                `Found elapsedTimeSeconds in metadata: ${elapsedTimeInSeconds} seconds`
              );
            }
          }

          // Convert seconds to minutes for storage, with minimum of 1 minute
          const reportTimeInMinutes = Math.max(
            1,
            Math.round(elapsedTimeInSeconds / 60)
          );
          console.log(
            `Converting ${elapsedTimeInSeconds} seconds to ${reportTimeInMinutes} minutes for report_time`
          );

          // Track the performance with the actual elapsed time
          await trackUserPerformance({
            client_id: clientResult[0].id, // Use numeric client ID
            user_id: user_id,
            report_id: result.insertId,
            report_name: template_name,
            report_time: reportTimeInMinutes, // Pass the elapsed time in minutes
            creation_timestamp: reportCreationTime, // Pass the creation timestamp
            elapsed_seconds: elapsedTimeInSeconds, // Pass the original seconds value
            status: reportStatus,
            score: null, // Score will be added later when implemented
          });
        } catch (perfError) {
          // Non-blocking - log but don't fail the request
          console.error("Error tracking user performance:", perfError);
        }

        return res.status(201).json({
          success: true,
          message: `Report saved successfully to ${clientReportsTable}`,
          data: {
            id: result.insertId,
            table: clientReportsTable,
            primary_field: {
              name: primaryFieldName,
              value: primaryFieldValue,
            },
            timestamp_url: timestamp_url,
          },
        });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error saving report:", error);
    return res.status(500).json({
      error: "Failed to save report",
      details: error.message,
    });
  }
};

/**
 * Fetch reports for a client
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const getReports = async (req, res) => {
  try {
    const { client_id } = req.params;
    const { user_id, user_email, user_role } = req.query; // Get user_id, user_email and user_role from query params

    if (!client_id) {
      return res.status(400).json({
        error: "Client ID is required",
      });
    }

    const connection = await db.getConnection();

    try {
      // First, get the client name for the table name - try by both id and uuid
      console.log("Looking for client with ID or UUID:", client_id);

      // First try with id
      let [clientResult] = await connection.query(
        "SELECT name, domain_name FROM clients WHERE id = ?",
        [client_id]
      );

      // If not found, try with uuid
      if (clientResult.length === 0) {
        console.log("Client not found by id, trying with uuid");
        [clientResult] = await connection.query(
          "SELECT name, domain_name FROM clients WHERE uuid = ?",
          [client_id]
        );

        // If still not found, return 404
        if (clientResult.length === 0) {
          return res.status(404).json({
            error: "Client not found",
          });
        }
      }

      // Store client information including domain_name
      const clientInfo = {
        name: clientResult[0].name,
        domain_name: clientResult[0].domain_name || null,
      };

      // Format client name to be used in table name
      const clientName = clientInfo.name
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_]/g, "")
        .toLowerCase();

      // Define the client-specific reports table name
      const clientReportsTable = `${clientName}_reports`;
      console.log("Using client reports table:", clientReportsTable);

      // Define the client-specific branches table name
      const clientBranchesTable = `${clientName}_branches`;
      console.log("Using client branches table:", clientBranchesTable);

      // Check if the client-specific reports table exists
      const [reportsTableExists] = await connection.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [clientReportsTable]
      );

      // If table doesn't exist yet, return empty array
      if (reportsTableExists[0].count === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          message: "No reports table exists for this client yet",
          client_info: clientInfo,
        });
      }

      // Check if the client-specific branches table exists
      const [branchesTableExists] = await connection.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [clientBranchesTable]
      );

      // Check if the table has the new dynamic primary field columns
      const [columnsCheck] = await connection.query(
        `
        SELECT 
          COUNT(*) as count 
        FROM information_schema.columns 
        WHERE 
          table_schema = DATABASE() 
          AND table_name = ? 
          AND column_name IN ('primary_field_name', 'primary_field_value')
      `,
        [clientReportsTable]
      );

      // Build WHERE clause and params array based on filters
      let whereClause = "r.client_id = ?";
      let queryParams = [client_id];

      // Add user_id filter if provided
      if (user_id) {
        whereClause += " AND r.created_by = ?";
        queryParams.push(user_id);
        console.log(`Filtering reports for user ID: ${user_id}`);
      }

      // Special handling for client_user role - they should only see reports for their assigned branches
      let allowedReportIds = null;
      const isClientUser = user_role === "client_user";

      if (isClientUser && user_email && branchesTableExists[0].count > 0) {
        console.log(
          `Client user detected with email: ${user_email}, filtering reports by branch access`
        );

        try {
          // First, find all column names in the branches table
          const [columnsResult] = await connection.query(
            `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = DATABASE() 
             AND TABLE_NAME = ?`,
            [clientBranchesTable]
          );

          console.log(
            `Found ${columnsResult.length} columns in branch table: ${clientBranchesTable}`
          );

          // Log column names for debugging
          console.log(
            "Branch table columns:",
            columnsResult
              .map((col) => `${col.COLUMN_NAME} (${col.DATA_TYPE})`)
              .join(", ")
          );

          // Find potential identifier columns (usually primary fields)
          const potentialIdColumns = columnsResult
            .filter(
              (col) =>
                col.COLUMN_NAME.toLowerCase() === "branch_code" ||
                col.COLUMN_NAME.toLowerCase() === "code" ||
                col.COLUMN_NAME.toLowerCase() === "id" ||
                col.COLUMN_NAME.toLowerCase() === "uuid" ||
                col.COLUMN_NAME.toLowerCase() === "branch_id" ||
                col.COLUMN_NAME.toLowerCase() === "region" ||
                col.COLUMN_NAME.toLowerCase() === "area"
            )
            .map((col) => col.COLUMN_NAME);

          console.log(`Potential ID columns: ${potentialIdColumns.join(", ")}`);

          // Find email columns
          const emailColumns = columnsResult
            .filter(
              (col) =>
                col.COLUMN_NAME.toLowerCase().includes("email") ||
                col.COLUMN_NAME.toLowerCase().includes("mail")
            )
            .map((col) => col.COLUMN_NAME);

          console.log(`Email columns: ${emailColumns.join(", ")}`);

          // Get all branches records
          const [branchesData] = await connection.query(
            `SELECT * FROM ${clientBranchesTable}`
          );

          console.log(`Found ${branchesData.length} branches in total`);

          // First, find branches assigned to this user's email
          const userBranches = [];
          const primaryFieldValues = new Set();

          // Normalize user email for comparison
          const normalizedUserEmail = user_email.toLowerCase().trim();

          // Find branches where user's email appears in any email column
          for (const branch of branchesData) {
            let hasAccess = false;

            // Check each potential email column
            for (const emailColumn of emailColumns) {
              const emailValue = branch[emailColumn];
              if (!emailValue) continue;

              // Convert to string for comparison
              const emailValueStr = String(emailValue).toLowerCase();

              // Check for exact match
              if (emailValueStr === normalizedUserEmail) {
                hasAccess = true;
                break;
              }

              // Check for email in comma/semicolon separated list
              if (emailValueStr.includes(",") || emailValueStr.includes(";")) {
                const emails = emailValueStr
                  .split(/[,;]/)
                  .map((e) => e.trim().toLowerCase());

                if (emails.includes(normalizedUserEmail)) {
                  hasAccess = true;
                  break;
                }
              }

              // Check for substring match as last resort
              if (emailValueStr.includes(normalizedUserEmail)) {
                hasAccess = true;
                break;
              }
            }

            // If user has access to this branch, add it to userBranches and collect its primary field values
            if (hasAccess) {
              userBranches.push(branch);

              // Collect all potential primary field values
              for (const idColumn of potentialIdColumns) {
                if (branch[idColumn]) {
                  primaryFieldValues.add(String(branch[idColumn]));
                }
              }
            }
          }

          console.log(
            `Found ${userBranches.length} branches assigned to user's email`
          );
          console.log(
            `Primary field values from user's branches: ${Array.from(
              primaryFieldValues
            ).join(", ")}`
          );

          // Get all reports with their primary field values
          const [reportsData] = await connection.query(
            `SELECT id, primary_field_name, primary_field_value, content 
             FROM ${clientReportsTable} 
             WHERE ${whereClause}`,
            queryParams
          );

          console.log(
            `Found ${reportsData.length} reports for filtering by branch access`
          );

          // Array to store allowed report IDs
          allowedReportIds = [];

          // For each report, check if its primary field value matches any of the user's branch values
          for (const report of reportsData) {
            let hasAccess = false;
            let primaryFieldName = report.primary_field_name;
            let primaryFieldValue = report.primary_field_value;

            // If primary_field_value is missing, try to extract from content
            if (!primaryFieldValue && report.content) {
              try {
                const content =
                  typeof report.content === "string"
                    ? JSON.parse(report.content)
                    : report.content;

                if (content.primaryField) {
                  primaryFieldName = content.primaryField.name;
                  primaryFieldValue = content.primaryField.value;
                }
              } catch (e) {
                console.error("Error parsing report content:", e);
              }
            }

            if (!primaryFieldValue) {
              console.log(
                `Report ${report.id} has no primary field value, skipping`
              );
              continue;
            }

            console.log(
              `Checking access for report ${report.id} with ${primaryFieldName}=${primaryFieldValue}`
            );

            // Convert to string for comparison
            const primaryFieldValueStr =
              String(primaryFieldValue).toLowerCase();

            // Check if any of the user's branch values matches this report's primary field value
            for (const branchValue of primaryFieldValues) {
              const branchValueStr = String(branchValue).toLowerCase();

              // Check for exact match or substring match
              if (
                primaryFieldValueStr === branchValueStr ||
                primaryFieldValueStr.includes(branchValueStr) ||
                branchValueStr.includes(primaryFieldValueStr)
              ) {
                console.log(
                  `Match found: Report value "${primaryFieldValueStr}" matches branch value "${branchValueStr}"`
                );
                hasAccess = true;
                break;
              }
            }

            // If user has access to this report's branch, add the report ID to allowed list
            if (hasAccess) {
              allowedReportIds.push(report.id);
              console.log(`Adding report ${report.id} to allowed list`);
            } else {
              console.log(`User does not have access to report ${report.id}`);
            }
          }

          // If we found allowed reports, add them to the WHERE clause
          if (allowedReportIds.length > 0) {
            whereClause += " AND r.id IN (?)";
            queryParams.push(allowedReportIds);
            console.log(
              `Filtered to ${allowedReportIds.length} reports that the user has access to`
            );
          } else {
            // If client user has no access to any reports, return empty array
            console.log(`Client user has no access to any reports`);
            return res.status(200).json({
              success: true,
              data: [],
              message: "No reports found for this user's branch assignments",
            });
          }
        } catch (error) {
          console.error(`Error filtering reports by branch access:`, error);
          // Continue with regular query if branch filtering fails
        }
      }

      // Query the client-specific table, including dynamic primary field if available
      let reports;
      if (columnsCheck[0].count === 2) {
        // Join with users table to get creator information
        [reports] = await connection.query(
          `SELECT r.*, r.primary_field_name, r.primary_field_value, 
            c.name as creator_name, c.uuid as creator_uuid,
            u.name as updater_name, u.uuid as updater_uuid,
            cl.domain_name as client_domain_name, cl.name as client_name
          FROM ${clientReportsTable} r
          LEFT JOIN users c ON r.created_by = c.id
          LEFT JOIN users u ON r.updated_by = u.id
          LEFT JOIN clients cl ON r.client_id = cl.uuid COLLATE utf8mb4_general_ci
          WHERE ${whereClause}
          ORDER BY r.created_at DESC`,
          queryParams
        );
      } else {
        // Fallback to original query if columns don't exist yet, but still include user information
        [reports] = await connection.query(
          `SELECT r.*, 
            c.name as creator_name, c.uuid as creator_uuid,
            u.name as updater_name, u.uuid as updater_uuid,
            cl.domain_name as client_domain_name, cl.name as client_name
          FROM ${clientReportsTable} r
          LEFT JOIN users c ON r.created_by = c.id 
          LEFT JOIN users u ON r.updated_by = u.id
          LEFT JOIN clients cl ON r.client_id = cl.uuid COLLATE utf8mb4_general_ci
          WHERE ${whereClause}
          ORDER BY r.created_at DESC`,
          queryParams
        );
      }

      // Parse JSON fields
      const formattedReports = reports.map((report) => {
        try {
          // Handle colors field
          let parsedColors = {};
          if (report.colors) {
            if (typeof report.colors === "object") {
              parsedColors = report.colors;
            } else {
              parsedColors = JSON.parse(report.colors);
            }
          }

          // Handle content field
          let parsedContent = {};
          if (report.content) {
            if (typeof report.content === "object") {
              parsedContent = report.content;
            } else {
              parsedContent = JSON.parse(report.content);
            }
          }

          // Create primary field information
          const primaryField = {
            name: report.primary_field_name || "branch_code",
            value: report.primary_field_value || null,
          };
          console.log(primaryField);

          // Add creator and updater info
          const creator = {
            id: report.created_by,
            name: report.creator_name || "Unknown",
            uuid: report.creator_uuid || null,
          };

          const updater = report.updated_by
            ? {
                id: report.updated_by,
                name: report.updater_name || "Unknown",
                uuid: report.updater_uuid || null,
              }
            : null;

          // Add client domain name and client name if available
          const domain_name =
            report.client_domain_name || clientInfo.domain_name;
          const client_name = report.client_name || clientInfo.name;

          return {
            id: report.id,
            client_id: report.client_id,
            client_name: client_name,
            template_name: report.template_name,
            status: report.status,
            created_at: report.created_at,
            updated_at: report.updated_at,
            content: parsedContent,
            colors: parsedColors,
            primary_field: primaryField,
            creator,
            updater,
            domain_name,
            media_links: {
              video_url: report.video_url || null,
              audio_url: report.audio_url || null,
              images_urls: report.images_urls
                ? typeof report.images_urls === "string"
                  ? JSON.parse(report.images_urls)
                  : report.images_urls
                : null,
            },
          };
        } catch (parseError) {
          console.error(
            `Error parsing JSON for report ${report.id}:`,
            parseError
          );
          return {
            ...report,
            colors: {},
            content: {},
            table: clientReportsTable,
            primary_field: {
              name: report.primary_field_name || "branch_code",
              value: report.primary_field_value || null,
            },
            creator: {
              id: report.created_by,
              name: report.creator_name || "Unknown",
              uuid: report.creator_uuid || null,
            },
            updater: {
              id: report.updated_by,
              name: report.updater_name || "Unknown",
              uuid: report.updater_uuid || null,
            },
            media_links: {
              video_url: report.video_url || null,
              audio_url: report.audio_url || null,
              images_urls: report.images_urls
                ? typeof report.images_urls === "string"
                  ? JSON.parse(report.images_urls)
                  : report.images_urls
                : null,
            },
          };
        }
      });

      return res.status(200).json({
        success: true,
        data: formattedReports,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error fetching reports:", error);
    return res.status(500).json({
      error: "Failed to fetch reports",
      details: error.message,
    });
  }
};

/**
 * Get a single report by ID
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const getReportById = async (req, res) => {
  try {
    const { id } = req.params;
    const { table, client_id, user_email, user_role } = req.query;

    if (!id) {
      return res.status(400).json({
        error: "Report ID is required",
      });
    }

    // For direct API calls with a table name/client_id
    const specifiedTable = table;
    const specifiedClientId = client_id;

    const connection = await db.getConnection();

    try {
      // Use the specified table if provided (for direct API access), otherwise determine from client_id
      let clientReportsTable = null;
      let clientBranchesTable = null;
      let resolvedClientId = null;
      let clientDomainName = null;

      if (specifiedTable) {
        // If the table name is explicitly provided, use it directly
        clientReportsTable = specifiedTable;
        clientBranchesTable = specifiedTable.replace("_reports", "_branches");
        console.log(
          `Using provided table name directly: ${clientReportsTable}`
        );
      } else if (specifiedClientId) {
        // If the client_id is directly provided, use it to determine the table name
        resolvedClientId = specifiedClientId;
        const [clientResult] = await connection.query(
          "SELECT name, domain_name FROM clients WHERE id = ? OR uuid = ?",
          [specifiedClientId, specifiedClientId]
        );

        if (clientResult.length === 0) {
          return res.status(404).json({
            error: "Client not found",
          });
        }

        const clientName = clientResult[0].name
          .replace(/\s+/g, "_")
          .replace(/[^a-zA-Z0-9_]/g, "")
          .toLowerCase();

        clientReportsTable = `${clientName}_reports`;
        clientBranchesTable = `${clientName}_branches`;
        clientDomainName = clientResult[0].domain_name;
        console.log(
          `Determined table name from client_id: ${clientReportsTable}`
        );
      } else {
        // If neither is provided, try to find the client_id in the reports table
        // This is a fallback for older clients or compatibility
        const [reportClientQuery] = await connection.query(
          "SELECT client_id FROM reports WHERE id = ?",
          [id]
        );

        if (reportClientQuery.length === 0) {
          console.log(
            `Report ${id} not found in main reports table, will try client-specific tables`
          );
        } else {
          resolvedClientId = reportClientQuery[0].client_id;
          const [clientResult] = await connection.query(
            "SELECT name, domain_name FROM clients WHERE id = ? OR uuid = ?",
            [resolvedClientId, resolvedClientId]
          );

          if (clientResult.length === 0) {
            return res.status(404).json({
              error: "Client not found",
            });
          }

          const clientName = clientResult[0].name
            .replace(/\s+/g, "_")
            .replace(/[^a-zA-Z0-9_]/g, "")
            .toLowerCase();

          clientReportsTable = `${clientName}_reports`;
          clientBranchesTable = `${clientName}_branches`;
          clientDomainName = clientResult[0].domain_name;
          console.log(
            `Determined table name from report's client_id: ${clientReportsTable}`
          );
        }
      }

      let report = null;

      // Check if the client-specific table exists and try to fetch from it first
      if (clientReportsTable) {
        const [tableExists] = await connection.query(
          "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
          [clientReportsTable]
        );

        if (tableExists[0].count > 0) {
          console.log(
            `Looking for report in client-specific table: ${clientReportsTable}`
          );
          [report] = await connection.query(
            `SELECT r.*, cl.domain_name as client_domain_name, cl.name as client_name, 
             r.video_url, r.audio_url, r.images_urls
             FROM ${clientReportsTable} r 
             LEFT JOIN clients cl ON r.client_id = cl.uuid COLLATE utf8mb4_general_ci
             WHERE r.id = ?`,
            [id]
          );

          // If report found, check client_user access
          if (
            report.length > 0 &&
            user_role === "client_user" &&
            user_email &&
            clientBranchesTable
          ) {
            const [branchesTableExists] = await connection.query(
              "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
              [clientBranchesTable]
            );

            if (branchesTableExists[0].count > 0) {
              console.log(
                `Checking client_user access for ${user_email} on report ${id}`
              );

              // Get the primary field details from the report
              const reportData = report[0];
              const primaryFieldName = reportData.primary_field_name;
              let primaryFieldValue = reportData.primary_field_value;

              // If primary_field_value is missing, try to extract from content
              if (!primaryFieldValue && reportData.content) {
                try {
                  const content =
                    typeof reportData.content === "string"
                      ? JSON.parse(reportData.content)
                      : reportData.content;

                  if (content.primaryField) {
                    primaryFieldName = content.primaryField.name;
                    primaryFieldValue = content.primaryField.value;
                  }
                } catch (e) {
                  console.error("Error parsing report content:", e);
                }
              }

              if (primaryFieldName && primaryFieldValue) {
                // Find all email columns in the branches table
                const [columnsResult] = await connection.query(
                  `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                   AND TABLE_NAME = ?
                   AND COLUMN_NAME LIKE '%email%'`,
                  [clientBranchesTable]
                );

                if (columnsResult.length > 0) {
                  // Get the branch that matches the report's primary field
                  const [branchData] = await connection.query(
                    `SELECT * FROM ${clientBranchesTable} 
                     WHERE ${primaryFieldName} = ?`,
                    [primaryFieldValue]
                  );

                  if (branchData.length > 0) {
                    // Check if user's email is in any of the branch's email columns
                    let hasAccess = false;
                    const branch = branchData[0];

                    for (const col of columnsResult) {
                      const columnName = col.COLUMN_NAME;

                      // Check exact match
                      if (branch[columnName] === user_email) {
                        console.log(
                          `Access granted: Found matching email in column ${columnName}`
                        );
                        hasAccess = true;
                        break;
                      }

                      // Check comma-separated list
                      if (
                        typeof branch[columnName] === "string" &&
                        branch[columnName].includes(",")
                      ) {
                        const emails = branch[columnName]
                          .split(",")
                          .map((e) => e.trim());
                        if (emails.includes(user_email)) {
                          console.log(
                            `Access granted: Found user email in list in column ${columnName}`
                          );
                          hasAccess = true;
                          break;
                        }
                      }
                    }

                    if (!hasAccess) {
                      console.log(
                        `Access denied: ${user_email} not found in branch email columns`
                      );
                      return res.status(403).json({
                        error:
                          "You don't have permission to access this report",
                        message:
                          "This report belongs to a branch you are not assigned to",
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      // If we still don't have a report, try the main reports table as a fallback
      if (!report || report.length === 0) {
        console.log(
          `Report not found in client-specific table, trying main reports table`
        );
        [report] = await connection.query(
          `SELECT r.*, cl.domain_name as client_domain_name, cl.name as client_name,
             r.video_url, r.audio_url, r.images_urls
             FROM reports r
             LEFT JOIN clients cl ON r.client_id = cl.uuid COLLATE utf8mb4_general_ci
             WHERE r.id = ?`,
          [id]
        );
      }

      // If no report found in any table
      if (!report || report.length === 0) {
        return res.status(404).json({
          error: "Report not found",
          message: `No report found with ID ${id} in any table`,
        });
      }

      // Prepare report data for response
      const reportData = report[0];
      let formattedReport = { ...reportData };

      // Add domain_name and client_name from client or query result
      formattedReport.domain_name =
        reportData.client_domain_name || clientDomainName;
      formattedReport.client_name = reportData.client_name;

      // Extract creator and updater information if available
      if (reportData.created_by) {
        const [creatorResult] = await connection.query(
          "SELECT id, name, uuid FROM users WHERE id = ?",
          [reportData.created_by]
        );

        if (creatorResult.length > 0) {
          formattedReport.creator = creatorResult[0];
        }
      }

      if (reportData.updated_by) {
        const [updaterResult] = await connection.query(
          "SELECT id, name, uuid FROM users WHERE id = ?",
          [reportData.updated_by]
        );

        if (updaterResult.length > 0) {
          formattedReport.updater = updaterResult[0];
        }
      }

      // Include the table name in the response for reference
      formattedReport.table = clientReportsTable || "reports";

      // Parse content if it's stored as JSON string
      if (
        formattedReport.content &&
        typeof formattedReport.content === "string"
      ) {
        try {
          formattedReport.content = JSON.parse(formattedReport.content);
        } catch (e) {
          console.error("Error parsing report content:", e);
        }
      }

      // Parse colors if it's stored as JSON string
      if (
        formattedReport.colors &&
        typeof formattedReport.colors === "string"
      ) {
        try {
          formattedReport.colors = JSON.parse(formattedReport.colors);
        } catch (e) {
          console.error("Error parsing report colors:", e);
        }
      }

      // Add media links to the formatted report with consistent format
      formattedReport.media_links = {
        video_url: reportData.video_url || null,
        audio_url: reportData.audio_url || null,
        images_urls: reportData.images_urls
          ? typeof reportData.images_urls === "string"
            ? JSON.parse(reportData.images_urls)
            : report.images_urls
          : null,
      };

      return res.status(200).json({
        success: true,
        data: formattedReport,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error in getReportById:", error);
    return res.status(500).json({
      error: error.message || "An error occurred while fetching the report",
    });
  }
};

/**
 * Delete a report
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const deleteReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { client_id, table } = req.query;

    if (!id) {
      return res.status(400).json({
        error: "Report ID is required",
      });
    }

    // Either client_id or table must be provided
    if (!client_id && !table) {
      return res.status(400).json({
        error: "Either client_id or table name is required",
      });
    }

    const connection = await db.getConnection();

    try {
      let clientReportsTable;

      // If table name is provided directly, use it
      if (table) {
        clientReportsTable = table;
      }
      // Otherwise, derive it from client_id
      else {
        // Get client name - try both id and uuid
        console.log("Looking for client with ID or UUID:", client_id);

        // First try with id
        let [clientResult] = await connection.query(
          "SELECT name FROM clients WHERE id = ?",
          [client_id]
        );

        // If not found, try with uuid
        if (clientResult.length === 0) {
          console.log("Client not found by id, trying with uuid");
          [clientResult] = await connection.query(
            "SELECT name FROM clients WHERE uuid = ?",
            [client_id]
          );

          // If still not found, return 404
          if (clientResult.length === 0) {
            return res.status(404).json({
              error: "Client not found",
            });
          }
        }

        // Format client name for table name
        const clientName = clientResult[0].name
          .replace(/\s+/g, "_")
          .replace(/[^a-zA-Z0-9_]/g, "")
          .toLowerCase();

        clientReportsTable = `${clientName}_reports`;
        console.log("Using client reports table:", clientReportsTable);
      }

      // Check if the table exists
      const [tableExists] = await connection.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [clientReportsTable]
      );

      if (tableExists[0].count === 0) {
        return res.status(404).json({
          error: `Report table ${clientReportsTable} does not exist`,
        });
      }

      // Check if report exists
      const [report] = await connection.query(
        `SELECT id FROM ${clientReportsTable} WHERE id = ?`,
        [id]
      );

      if (report.length === 0) {
        return res.status(404).json({
          error: "Report not found",
        });
      }

      // Delete the report
      await connection.query(`DELETE FROM ${clientReportsTable} WHERE id = ?`, [
        id,
      ]);

      return res.status(200).json({
        success: true,
        message: `Report deleted successfully from ${clientReportsTable}`,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error deleting report:", error);
    return res.status(500).json({
      error: "Failed to delete report",
      details: error.message,
    });
  }
};

/**
 * Update report status
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const updateReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, user_id: requestUserId } = req.body;
    const { client_id, table } = req.query;
    // Use user_id from request payload if provided, otherwise fall back to JWT token
    const user_id = requestUserId || req.user?.id || null;

    console.log(
      "Updating report status to:",
      status,
      "User ID for update:",
      user_id,
      "Request payload ID:",
      requestUserId,
      "JWT token ID:",
      req.user?.id
    );

    if (!id) {
      return res.status(400).json({
        error: "Report ID is required",
      });
    }

    if (!status) {
      return res.status(400).json({
        error: "Status is required",
      });
    }

    // Either client_id or table must be provided
    if (!client_id && !table) {
      return res.status(400).json({
        error: "Either client_id or table name is required",
      });
    }

    // Validate status value
    const validStatuses = ["draft", "submitted", "approved", "rejected"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const connection = await db.getConnection();

    try {
      let clientReportsTable;

      // If table name is provided directly, use it
      if (table) {
        clientReportsTable = table;
      }
      // Otherwise, derive it from client_id
      else {
        // Get client name - try both id and uuid
        console.log("Looking for client with ID or UUID:", client_id);

        // First try with id
        let [clientResult] = await connection.query(
          "SELECT name FROM clients WHERE id = ?",
          [client_id]
        );

        // If not found, try with uuid
        if (clientResult.length === 0) {
          console.log("Client not found by id, trying with uuid");
          [clientResult] = await connection.query(
            "SELECT name FROM clients WHERE uuid = ?",
            [client_id]
          );

          // If still not found, return 404
          if (clientResult.length === 0) {
            return res.status(404).json({
              error: "Client not found",
            });
          }
        }

        // Format client name for table name
        const clientName = clientResult[0].name
          .replace(/\s+/g, "_")
          .replace(/[^a-zA-Z0-9_]/g, "")
          .toLowerCase();

        clientReportsTable = `${clientName}_reports`;
        console.log("Using client reports table:", clientReportsTable);
      }

      // Check if the table exists
      const [tableExists] = await connection.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [clientReportsTable]
      );

      if (tableExists[0].count === 0) {
        return res.status(404).json({
          error: `Report table ${clientReportsTable} does not exist`,
        });
      }

      // Check if report exists and get report details
      const [reportDetails] = await connection.query(
        `SELECT id, created_by, template_name, created_at FROM ${clientReportsTable} WHERE id = ?`,
        [id]
      );

      if (reportDetails.length === 0) {
        return res.status(404).json({
          error: "Report not found",
        });
      }

      // Get the report creator's user ID and other details
      const reportCreatorId = reportDetails[0].created_by;
      const reportName = reportDetails[0].template_name || "Unknown Report";
      const reportCreatedAt = reportDetails[0].created_at;

      // Update the report status
      await connection.query(
        `UPDATE ${clientReportsTable} SET status = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
        [status, user_id, id]
      );

      // Also update the user_performance table
      if (reportCreatorId && client_id) {
        try {
          // Convert client_id to numeric ID if it's a UUID
          let clientNumericId = client_id;
          if (isNaN(Number(client_id))) {
            const [clientResult] = await connection.query(
              "SELECT id FROM clients WHERE uuid = ?",
              [client_id]
            );
            if (clientResult.length > 0) {
              clientNumericId = clientResult[0].id;
            }
          }

          // First, query the existing user_performance record to get current values
          const [existingPerformance] = await connection.query(
            `SELECT report_time, elapsed_seconds, score FROM user_performance 
             WHERE client_id = ? AND user_id = ? AND report_id = ?`,
            [clientNumericId, reportCreatorId, id]
          );

          // Prepare data for user_performance update
          const performanceData = {
            client_id: clientNumericId,
            user_id: reportCreatorId,
            report_id: id,
            report_name: reportName,
            // Preserve existing values instead of setting to 0
            report_time:
              existingPerformance.length > 0
                ? existingPerformance[0].report_time
                : null,
            creation_timestamp: reportCreatedAt,
            elapsed_seconds:
              existingPerformance.length > 0
                ? existingPerformance[0].elapsed_seconds
                : null,
            status: status, // Using the new status
            score:
              existingPerformance.length > 0
                ? existingPerformance[0].score
                : null,
          };

          // Update user_performance status
          await trackUserPerformance(performanceData);
          console.log(
            `Updated user_performance record for report ${id} with status ${status}`
          );
        } catch (perfError) {
          console.error("Error updating user_performance record:", perfError);
          // Don't fail the request if this update fails
        }
      }

      return res.status(200).json({
        success: true,
        message: `Report status updated successfully to ${status}`,
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Error updating report status:", error);
    return res.status(500).json({
      error: "Failed to update report status",
      details: error.message,
    });
  }
};

// Add new function for client dashboard data
const getClientDashboardData = async (req, res) => {
  try {
    const { client_id, user_email, user_role } = req.body;

    if (!client_id) {
      return res.status(400).json({
        status: "error",
        message: "Client ID is required",
      });
    }

    // Check if the client exists and get proper client table name
    const [clientResult] = await db.query(
      "SELECT name FROM clients WHERE id = ? OR uuid = ?",
      [client_id, client_id]
    );

    if (clientResult.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Client not found",
      });
    }

    // Format client name for table name
    const clientName = clientResult[0].name
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .toLowerCase();

    // Use client-specific table
    const clientReportsTable = `${clientName}_reports`;
    const clientBranchesTable = `${clientName}_branches`;

    // Check if the table exists
    const [tableExists] = await db.query(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
      [clientReportsTable]
    );

    if (tableExists[0].count === 0) {
      return res.status(404).json({
        status: "error",
        message: `Client reports table ${clientReportsTable} does not exist`,
      });
    }

    // Get the columns from the client-specific reports table
    const [columns] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [clientReportsTable]
    );

    // Build a dynamic query using only the columns that exist
    const columnNames = columns.map((col) => col.COLUMN_NAME);

    // Select only columns that we need and that exist in the table
    const selectColumns = [];
    const standardColumns = [
      "id",
      "client_id",
      "primary_field_name",
      "primary_field_value",
      "template_name",
      "status",
      "created_at",
      "updated_at",
    ];

    standardColumns.forEach((col) => {
      if (columnNames.includes(col)) {
        selectColumns.push(`r.${col}`);
      }
    });

    // Add content as it contains other useful data
    if (columnNames.includes("content")) {
      selectColumns.push("r.content");
    }

    // Build the WHERE clause - only filter by client_id and status
    let whereClause = "r.client_id = ? AND r.status = 'approved'";
    let queryParams = [client_id];

    // REMOVED: Special handling for client_user role - Now all users can see all approved reports
    // Logging that branch filtering is bypassed
    console.log(
      `Branch filtering bypassed: ${user_email} with role ${user_role} can see all reports`
    );

    // Execute the query with our dynamic WHERE clause
    const query = `
      SELECT ${selectColumns.join(", ")}
      FROM ${clientReportsTable} r
      WHERE ${whereClause}
      ORDER BY r.created_at DESC
    `;

    console.log(`Executing query: ${query}`);
    console.log(`With parameters: ${queryParams.join(", ")}`);

    const [reports] = await db.query(query, queryParams);
    console.log(`Found ${reports.length} reports matching the criteria`);

    // Process the reports to extract needed fields from content if they don't exist as columns
    const processedReports = reports.map((report) => {
      let reportData = { ...report };

      // Extract data from content if it exists
      if (report.content) {
        try {
          const content =
            typeof report.content === "string"
              ? JSON.parse(report.content)
              : report.content;

          // Extract branch name, score, etc. from content
          if (content.primaryField) {
            reportData.branch_name = content.primaryField.value;
          }

          // Check if reports array exists (containing sections with achieved percentages)
          if (Array.isArray(content.reports)) {
            // Calculate overall score as simple average of all section scores
            let totalScore = 0;
            let validSectionCount = 0;

            content.reports.forEach((section) => {
              // Parse achieved percentage (remove % sign and convert to number)
              const achievedPercentage = parseFloat(
                section.achieved?.replace("%", "") || 0
              );

              // Only count valid percentage values
              if (!isNaN(achievedPercentage)) {
                totalScore += achievedPercentage;
                validSectionCount++;
              }
            });

            // Calculate final score (simple average)
            if (validSectionCount > 0) {
              reportData.score = Math.round(totalScore / validSectionCount);
            }

            // Store the sections data for reference
            reportData.sections = content.reports.map((section) => ({
              heading: section.heading || "",
              achieved: section.achieved || "0%",
              weightage: section.weightage || "0%",
            }));
          }
          // If no reports array but content has score directly
          else if (content.score !== undefined) {
            reportData.score = content.score;
          } else if (content.totalScore !== undefined) {
            reportData.score = content.totalScore;
          }

          // Try to find report type
          if (content.reportType) {
            reportData.report_type = content.reportType;
          }

          // Extract date if available
          if (content.date) {
            reportData.date = content.date;
          }
        } catch (error) {
          console.error("Error parsing content JSON:", error);
        }
      }

      return reportData;
    });

    return res.status(200).json({
      status: "success",
      message: "Reports fetched successfully",
      data: processedReports,
    });
  } catch (error) {
    console.error("Error fetching client dashboard data:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch client dashboard data",
      error: error.message,
    });
  }
};

module.exports = {
  saveReport,
  getReports,
  getReportById,
  deleteReport,
  updateReportStatus,
  getClientDashboardData,
};
