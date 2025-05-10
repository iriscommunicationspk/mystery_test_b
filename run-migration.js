// Run migration script
const migration = require("./src/database/migrations/add_domain_name_to_clients.js");

async function runMigration() {
  console.log("Running migration to add domain_name to clients table...");

  try {
    const result = await migration.up();

    if (result) {
      console.log("Migration successful!");
    } else {
      console.error("Migration failed");
    }
  } catch (error) {
    console.error("Error running migration:", error);
  }
}

runMigration();
