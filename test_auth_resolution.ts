import { parseGeminiAuth } from "./src/infra/gemini-auth.js";

async function test() {
  console.log("Testing parseGeminiAuth with marker...");
  const auth = parseGeminiAuth("gcp-vertex-credentials");
  console.log("Headers:", JSON.stringify(auth.headers, null, 2));

  if (auth.headers.Authorization && auth.headers.Authorization.startsWith("Bearer ya29.")) {
    console.log("SUCCESS: Resolved token correctly.");
  } else {
    console.log("FAILURE: Did not resolve token correctly.");
  }
}

test().catch(console.error);
