const { KEY_MAP } = require("./config");

const cache = {};

// Lazy-loads and caches provider modules by name.
function getProvider(name) {
  if (cache[name]) return cache[name];
  if (!Object.prototype.hasOwnProperty.call(KEY_MAP, name)) {
    throw new Error(`Unknown provider: "${name}"`);
  }
  cache[name] = require(`../providers/${name}`);
  return cache[name];
}

module.exports = { getProvider };
