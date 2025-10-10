// /.netlify/functions/upload-overrides.js
// Writes automation/overrides.json to GitHub repo (main branch) using a PAT.
// Secure via ADMIN_KEY header, plus Netlify env vars.
// CORS is limited to your Netlify site origin.

import fetch from "node-fetch";

const {
  ADMIN_KEY,
  GITHUB_TOKEN,
  REPO_OWNER = "AlvaroTrabanco",
  REPO_NAME  = "gtfs-editor",
  TARGET_BRANCH = "main",
  OVERRIDES_PATH = "automation/overrides.json",
  ALLOW_ORIGIN
} = process.env;

const okJson = (status, body, origin) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin || "*",            // set to your site URL if you want strict CORS
    "Access-Control-Allow-Headers": "Content-Type,x-admin-key",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
  },
  body: JSON.stringify(body)
});

export const handler = async (event) => {
  const origin = ALLOW_ORIGIN || event.headers.origin || "*";

  if (event.httpMethod === "OPTIONS") {
    return okJson(200, { ok: true }, origin);
  }

  if (event.httpMethod !== "POST") {
    return okJson(405, { error: "Method not allowed" }, origin);
  }

  if (!ADMIN_KEY) return okJson(500, { error: "ADMIN_KEY not configured" }, origin);
  if (!GITHUB_TOKEN) return okJson(500, { error: "GITHUB_TOKEN not configured" }, origin);

  const headerKey = event.headers["x-admin-key"];
  if (!headerKey || headerKey !== ADMIN_KEY) {
    return okJson(401, { error: "Unauthorized" }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return okJson(400, { error: "Invalid JSON body" }, origin);
  }

  const message = String(payload.message || "Update overrides.json");
  const contentText = String(payload.content || "");

  if (!contentText) return okJson(400, { error: "Missing content" }, origin);

  // Validate JSON early
  try { JSON.parse(contentText); }
  catch { return okJson(400, { error: "Content is not valid JSON" }, origin); }

  // Read existing file to get SHA (required for updates)
  const baseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(OVERRIDES_PATH)}`;
  let sha = undefined;

  const getRes = await fetch(`${baseUrl}?ref=${encodeURIComponent(TARGET_BRANCH)}`, {
    headers: { "Authorization": `Bearer ${GITHUB_TOKEN}`, "Accept": "application/vnd.github+json" }
  });

  if (getRes.status === 200) {
    const data = await getRes.json();
    sha = data.sha;
  } else if (getRes.status !== 404) {
    return okJson(getRes.status, { error: "Failed to read current file", detail: await getRes.text() }, origin);
  }

  // PUT new content
  const putRes = await fetch(baseUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json"
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(contentText).toString("base64"),
      branch: TARGET_BRANCH,
      sha
    })
  });

  const putData = await putRes.json();
  if (!putRes.ok) {
    return okJson(putRes.status, { error: "GitHub write failed", detail: putData }, origin);
  }

  return okJson(200, {
    ok: true,
    commitSha: putData.commit?.sha,
    htmlUrl: putData.content?.html_url
  }, origin);
};