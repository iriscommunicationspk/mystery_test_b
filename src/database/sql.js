var mysql = require("mysql2/promise");

console.log("Configuring database connection...");

var con = mysql.createPool({
  // host: "localhost",
  host: "147.79.100.197",
  port: 3306,
  database: "saqib_ms",
  user: "saqib_admin",
  // password: "Mangoman@987",
  password: "Mangoman@987",
  connectionLimit: 10,
  // Adding MySQL configuration parameters to address sort memory issues
  connectAttributes: {
    sort_buffer_size: "16M", // Increase sort buffer size (default is usually 256K)
    tmp_table_size: "64M", // Increase temporary table size
    max_heap_table_size: "64M", // Increase heap table size
  },
});

/**
 * Helper function to optimize MySQL session for operations requiring large sorts
 * @param {Object} connection - MySQL connection object
 * @returns {Promise<void>}
 */
async function optimizeConnectionForSorting(connection) {
  try {
    await connection.query("SET SESSION sort_buffer_size = 16*1024*1024"); // 16MB
    await connection.query("SET SESSION tmp_table_size = 64*1024*1024"); // 64MB
    await connection.query("SET SESSION max_heap_table_size = 64*1024*1024"); // 64MB
    await connection.query("SET SESSION join_buffer_size = 8*1024*1024"); // 8MB
  } catch (error) {
    console.error("Error setting MySQL session variables:", error);
  }
}

// var con = mysql.createPool({
//   host: "127.0.0.1",
//   port: 3306,
//   database: "saqib_mystery_shopping",
//   user: "saqib",
//   password: "Mangoman@987",
// });

(async () => {
  try {
    // Test the connection by getting a connection from the pool
    const connection = await con.getConnection();
    console.log("Database connected successfully!");

    // Set session variables for the current connection
    await optimizeConnectionForSorting(connection);

    // Test query to check if ranges table exists
    const [tables] = await connection.query("SHOW TABLES LIKE 'ranges'");
    if (tables.length > 0) {
      console.log("Ranges table exists in the database");

      // Get table structure
      const [columns] = await connection.query("DESCRIBE ranges");
      console.log(
        "Ranges table structure:",
        columns.map((col) => col.Field)
      );
    } else {
      console.log("WARNING: Ranges table does not exist in the database!");
    }

    connection.release(); // Release the connection back to the pool
  } catch (err) {
    console.error("Database connection failed:", err.message);
    throw err; // Re-throw the error to handle it further if needed
  }
})();

// Add optimizeConnectionForSorting to exports
con.optimizeConnectionForSorting = optimizeConnectionForSorting;

module.exports = con;
