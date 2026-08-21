// Tiny cross-cutting helpers with no domain logic.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { sleep };
