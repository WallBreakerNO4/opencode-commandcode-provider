{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ccproto": {
      "npm": "file://__PKG__/index.js",
      "name": "CCProto",
      "options": { "apiKey": "dummy-config-key" },
      "models": {
        "fake-1": {
          "id": "fake-1",
          "name": "Fake One",
          "tool_call": true,
          "reasoning": false,
          "attachment": false,
          "temperature": true,
          "limit": { "context": 128000, "output": 8192 },
          "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
          "modalities": { "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
