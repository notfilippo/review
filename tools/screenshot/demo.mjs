// Each demo patch includes the whole file so its two versions can be derived.
function reviewFile(path, body) {
  const lines = body.trimEnd().split("\n");
  const oldContents = lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
  const newContents = lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
  return {
    path,
    status: "Modified",
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldContents.length} +1,${newContents.length} @@\n${body}`,
    old_file: { name: path, contents: `${oldContents.join("\n")}\n` },
    new_file: { name: path, contents: `${newContents.join("\n")}\n` },
  };
}

export const session = {
  server_id: "screenshot",
  restart_command: "review",
  files: [
    reviewFile("src/cache.rs", ` use std::collections::HashMap;
 use std::time::{Duration, Instant};
 
 struct Entry {
     value: String,
     expires_at: Instant,
 }
 
 pub struct Cache {
     entries: HashMap<String, Entry>,
     ttl: Duration,
 }
 
 impl Cache {
     pub fn get(&self, key: &str) -> Option<&str> {
-        self.entries.get(key).map(|entry| entry.value.as_str())
+        let now = Instant::now();
+        self.entries
+            .get(key)
+            .filter(|entry| entry.expires_at > now)
+            .map(|entry| entry.value.as_str())
     }
 
     pub fn insert(&mut self, key: String, value: String) {
         self.entries.insert(
             key,
             Entry {
                 value,
                 expires_at: Instant::now() + self.ttl,
             },
         );
     }
 }
`),
    reviewFile("README.md", ` # Cache
 
-Cached entries remain available until they are replaced.
+Cached entries expire after the configured time to live.
`),
  ],
  comments: [
    {
      id: "expiry",
      path: "src/cache.rs",
      side: "additions",
      end_side: "additions",
      start_line: 19,
      end_line: 19,
      text: "Could we also remove expired entries so the cache does not keep growing?",
    },
    {
      id: "ttl-docs",
      path: "README.md",
      side: "additions",
      end_side: "additions",
      start_line: 3,
      end_line: 3,
      text: "Please document the default TTL and how to configure it.",
    },
  ],
};
