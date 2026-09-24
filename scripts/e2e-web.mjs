import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { redact } from "./redact.mjs";
import { CLERK_BROWSER_ENTRY } from "./zip-entry-sha.mjs";

const HARNESS_FILES = ["project.godot", "export_presets.cfg", "e2e_driver.gd", "e2e_main.tscn"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function prepareProject(zipPath, harnessDir, dest) {
  mkdirSync(dest, { recursive: true });
  const unzipped = spawnSync("unzip", ["-q", zipPath, "-d", dest], { encoding: "utf8" });
  if (unzipped.status !== 0) throw new Error("addon zip could not be unpacked");
  for (const name of HARNESS_FILES) cpSync(join(harnessDir, name), join(dest, name));
  return dest;
}

export function assertWebExport(html, exportedClerkPath, expectedSha) {
  if (!html.includes('src="gd-clerk/clerk.browser.js"') || !html.includes('src="gd-clerk/gd_clerk_bridge.js"')) {
    throw new Error("web export did not inject pinned clerk scripts");
  }
  if (/https?:\/\/[^"']+clerk\.browser\.js/i.test(html) || html.includes("cdn.jsdelivr.net") || html.includes("unpkg.com")) {
    throw new Error("web export must not load Clerk from a CDN");
  }
  if (/Cross-Origin-Embedder-Policy/i.test(html) && /require-corp/i.test(html)) {
    throw new Error("web export requires cross-origin isolation; Turnstile cannot load");
  }
  if (!existsSync(exportedClerkPath)) throw new Error("web export is missing the pinned clerk bundle");
  const actual = createHash("sha256").update(readFileSync(exportedClerkPath)).digest("hex");
  if (actual !== expectedSha) throw new Error("exported clerk bundle does not match the tested ZIP");
  return actual;
}

export function exportWebProject({ godotBin, projectDir, outHtml, env }) {
  const version = spawnSync(godotBin, ["--version"], { encoding: "utf8", env });
  if (!String(version.stdout || "").includes("4.7.2")) throw new Error("godot 4.7.2 is required");
  const imported = spawnSync(godotBin, ["--headless", "--import", "--path", projectDir, "--quit"], {
    encoding: "utf8",
    env,
    timeout: 180000,
  });
  if (imported.status !== 0 || /SCRIPT ERROR|Parse Error/.test(`${imported.stdout || ""}\n${imported.stderr || ""}`)) {
    throw new Error(`godot project import failed: ${redact(imported.stderr || imported.stdout || "")}`);
  }
  mkdirSync(dirname(outHtml), { recursive: true });
  const result = spawnSync(godotBin, ["--headless", "--path", projectDir, "--export-release", "Web", outHtml], {
    encoding: "utf8",
    env,
    timeout: 180000,
  });
  if (result.status !== 0) throw new Error(`godot web export failed: ${redact(result.stderr || result.stdout || "")}`);
  return outHtml;
}

export function createExportServer(root, port = 3100) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    let pathname = "/";
    try {
      const raw = req.url || "/";
      if (raw.includes("..") || /%2e/i.test(raw)) {
        res.writeHead(403);
        res.end();
        return;
      }
      pathname = decodeURIComponent(new URL(raw, "http://localhost").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const path = resolve(base, `.${pathname}`);
    if (path !== base && !path.startsWith(`${base}/`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = TYPES[extname(path)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416);
        res.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start > end || end >= stat.size) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    createReadStream(path).pipe(res);
  });
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

function mergeCaptcha(left, right) {
  return {
    slotMounted: !!(left.slotMounted || right?.slotMounted),
    invisible: !!(left.invisible || right?.invisible),
    challengeVisible: !!(left.challengeVisible || right?.challengeVisible),
    testingToken: !!(left.testingToken || right?.testingToken),
  };
}

async function send(page, command, timeout) {
  const id = command.id;
  await page.evaluate((payload) => {
    window.__gdClerkE2E.result = null;
    window.__gdClerkE2E.command = payload;
  }, command);
  const started = Date.now();
  let captcha = { slotMounted: false, invisible: false, challengeVisible: false, testingToken: false };
  while (Date.now() - started < timeout) {
    const snap = await page.evaluate((expected) => {
      const obs = window.__gdClerkObserve ? window.__gdClerkObserve() : null;
      const result = window.__gdClerkE2E && window.__gdClerkE2E.result;
      return { obs, result: result && result.id === expected ? result : null };
    }, id);
    captcha = mergeCaptcha(captcha, snap.obs);
    if (snap.result) return { result: snap.result, captcha };
    await page.waitForTimeout(200);
  }
  const err = new Error("e2e command timed out");
  err.captcha = captcha;
  throw err;
}

export async function driveExportedGame(options) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let seq = 0;
  const next = (op, extra = {}) => ({ id: ++seq, op, ...extra });
  try {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => window.__gdClerkE2E && window.__gdClerkE2E.ready === true, null, { timeout: 120000 });
    await page.evaluate(() => {
      window.__gdClerkObserve = function () {
        var slot = document.getElementById("clerk-captcha");
        var frames = Array.prototype.slice.call(document.querySelectorAll("iframe"));
        var challenge = frames.some(function (frame) {
          var src = frame.getAttribute("src") || "";
          var host = src.indexOf("challenges.cloudflare.com") !== -1 || src.indexOf("turnstile") !== -1;
          return host && frame.offsetWidth > 8 && frame.offsetHeight > 8;
        });
        var cookies = document.cookie.split(";").map(function (part) { return part.split("=")[0].trim().toLowerCase(); });
        return {
          slotMounted: !!(slot && slot.isConnected),
          invisible: !!document.querySelector(".clerk-invisible-captcha"),
          challengeVisible: challenge,
          testingToken: /__clerk_testing_token/i.test(location.href) || !!window.__clerk_testing_token || cookies.some(function (name) { return name.indexOf("testing") !== -1; }),
        };
      };
    });
    const initial = await page.evaluate(() => window.__gdClerkObserve());
    if (initial.testingToken) throw new Error("captcha bypass detected; challenge was not marked accepted");
    const configured = await send(page, next("configure", {
      publishable_key: options.publishableKey,
      frontend_api: options.frontendApi,
      allowed_origins: [options.origin],
    }), 45000);
    if (configured.result.state !== "CONFIGURED") {
      throw new Error(`configure failed: ${configured.result.state}/${configured.result.error_key}`);
    }
    const signUpStart = new Date().toISOString();
    let began;
    try {
      began = await send(page, next("begin", { email: options.signUpEmail, mode: 1 }), 150000);
    } catch (err) {
      if (!err.captcha || !err.captcha.challengeVisible) throw err;
      began = { result: { state: "ERROR", error_key: "UNKNOWN" }, captcha: err.captcha };
    }
    return { began, signUpStart, page, browser, send, next };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function completeCode(page, send, next, fetchOtp, recipient, testStart) {
  const code = await fetchOtp({ recipient, testStart });
  const done = await send(page, next("complete", { code }), 45000);
  if (done.result.state !== "AUTHENTICATED") {
    throw new Error(`complete failed: ${done.result.state}/${done.result.error_key}`);
  }
}

export async function exerciseBrowser(options) {
  const session = await driveExportedGame(options);
  const { page, browser, send, next, began, signUpStart } = session;
  try {
    const classified = options.classify({
      state: began.result.state,
      errorKey: began.result.error_key,
      captcha: began.captcha,
    });
    if (classified.fail) throw new Error(classified.fail);
    let signInEmail = options.signUpEmail;
    if (classified.email_code_sign_up === "delivered") {
      await completeCode(page, send, next, options.fetchOtp, options.signUpEmail, signUpStart);
      const cleared = await send(page, next("sign_out"), 45000);
      if (cleared.result.state !== "SIGNED_OUT") throw new Error("sign-up session could not be cleared");
    } else if (!options.signInEmail) {
      throw new Error("sign-up blocked by interactive Turnstile; no pre-created sign-in mailbox. Challenge was not marked accepted.");
    } else {
      signInEmail = options.signInEmail;
    }
    const signInStart = new Date().toISOString();
    const signIn = await send(page, next("begin", { email: signInEmail, mode: 0 }), 45000);
    if (signIn.result.state !== "CODE_SENT") throw new Error(`sign-in failed: ${signIn.result.state}/${signIn.result.error_key}`);
    await completeCode(page, send, next, options.fetchOtp, signInEmail, signInStart);
    await page.route("**/*", (route) => {
      if (route.request().url().startsWith(options.frontendApi)) route.abort();
      else route.continue();
    });
    const faulted = await send(page, next("sign_out"), 45000);
    if (faulted.result.state === "SIGNED_OUT") throw new Error("sign-out was confirmed during a network fault");
    if (faulted.result.state !== "SIGN_OUT_FAILED") {
      throw new Error(`network failure was not observed: ${faulted.result.state}/${faulted.result.error_key}`);
    }
    await page.unroute("**/*");
    const signedOut = await send(page, next("sign_out"), 45000);
    let after = await send(page, next("session"), 10000);
    for (let i = 0; i < 10 && (after.result.signed_in || after.result.session_status !== "signed_out"); i++) {
      await page.waitForTimeout(200);
      after = await send(page, next("session"), 10000);
    }
    if (signedOut.result.state !== "SIGNED_OUT" || after.result.signed_in || after.result.session_status !== "signed_out") {
      throw new Error("sign-out was not confirmed");
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => window.__gdClerkE2E && window.__gdClerkE2E.ready === true, null, { timeout: 120000 });
    const again = await send(page, next("configure", {
      publishable_key: options.publishableKey,
      frontend_api: options.frontendApi,
      allowed_origins: [options.origin],
    }), 45000);
    if (again.result.state !== "CONFIGURED") throw new Error("reload configure failed");
    let reloaded = await send(page, next("session"), 10000);
    for (let i = 0; i < 10 && (reloaded.result.signed_in || reloaded.result.session_status !== "signed_out"); i++) {
      await page.waitForTimeout(200);
      reloaded = await send(page, next("session"), 10000);
    }
    if (reloaded.result.session_status !== "signed_out" || reloaded.result.signed_in) {
      throw new Error("reload did not confirm signed-out");
    }
    return classified;
  } finally {
    await browser.close();
  }
}

export { CLERK_BROWSER_ENTRY };
