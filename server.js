import express from "express";
import puppeteerExtra from "puppeteer-extra";
import puppeteer from "puppeteer"; // make sure Puppeteer is installed
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
// debug is enabled if first argument is "debug"
const debug = process.argv[2] === "debug";

// Run headed when an X display is available (xvfb-run in the container) so the
// browser presents a real, non-headless fingerprint to bot detection (Cloudflare
// Turnstile). Fall back to "new" headless when no display is set, so the service
// still boots in display-less environments instead of crash-looping.
const headless = process.env.DISPLAY ? false : "new";

puppeteerExtra.use(
  AdblockerPlugin(),
  // Stealth patches the residual JS-level automation tells (navigator.webdriver,
  // window.chrome, plugins/mimeTypes, ...). As of 2026 stealth alone does NOT
  // defeat Cloudflare — the CDP/TLS fingerprint still flags automation — so it
  // is combined with headed (Xvfb) mode above, which removes the headless signal.
  StealthPlugin()
);

const app = express();
app.use(express.json());


let browserPromise = await puppeteerExtra.launch({
  headless,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  executablePath: puppeteer.executablePath()
});
let browser = await browserPromise;

const RENDER_DEADLINE_MS = Number(process.env.RENDER_DEADLINE_MS) || 45000;

// Rejects after ms so a hung page.* call cannot hold a page (and its CPU) open forever.
const withDeadline = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`deadline ${ms}ms exceeded`)), ms)),
]);

// Close without ever throwing or hanging the handler; a stuck close falls back to killing the target.
const closePage = async (page) => {
  if (!page) return;
  try {
    await withDeadline(page.close({ runBeforeUnload: false }), 5000);
  } catch {
    try { await page.target().createCDPSession().then(c => c.send("Page.crash")); } catch {}
  }
};

app.post("/render", async (req, res) => {
  const { url, clicks, includeHeaders, includeCookies } = req.body;

  if (!url) {
    return res.status(400).send("Missing url");
  }
  console.log(`Rendering URL: ${url} with clicks: ${JSON.stringify(clicks)}`);
  let page;
  try {
    await withDeadline((async () => {
    // catch if browser is closed and relaunch
    if (!browser.isConnected()) {
      console.log("Browser disconnected, relaunching...");
      browserPromise = await puppeteerExtra.launch({
        headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
        executablePath: puppeteer.executablePath()
      });
      browser = await browserPromise;
    }
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // TODO: add future options to set headers from the request
    // await page.setExtraHTTPHeaders({
    //   "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
    // });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });// or networkidle2;
    console.log(`Page loaded: ${url}`);
    await page.setViewport({ width: 1280, height: 800 });
    
    // If we got clicks, execute them in sequence
    if (Array.isArray(clicks)) {
      // if debug enabled, create pics directory
      if (debug) {
        await page.screenshot({ path: "pics/before-clicks.png", fullPage: true });
      }
      for (const click of clicks) {
        if (debug) {
          await page.screenshot({ path: `pics/before-click-${clicks.indexOf(click)}.png`, fullPage: true });
        }
        try {
          let selector;

          if (click.type === "css") {
            selector = click.selector;
          } else if (click.type === "attr") {
            selector = `[${click.name}="${click.value}"]`;
          } else if (click.type === "text") {
            selector = `xpath///button[contains(text(),"${click.value}")]`;
          }

          if (selector) {
            console.log(`Performing click on selector: ${selector}`);
            if (selector.startsWith("xpath/")) {
              const xpath = selector.replace("xpath/", "");
              await page.waitForXPath(xpath, { timeout: 5000 });
              const [el] = await page.$x(xpath);
              if (el) {
                try {
                  console.log(`Clicking XPath: ${xpath}`);
                  await el.click(); // normal click
                  console.log(`Clicked XPath: ${xpath}`);
                } catch {
                  console.warn("XPath click failed, trying fallback");
                  // force click fallback
                  await el.evaluate(e => e.click());
                  console.log(`Fallback clicked XPath: ${xpath}`);
                }
              }
            } else {
              console.log(`Waiting for selector: ${selector}`);
              await page.waitForSelector(selector, { timeout: 5000 });
              console.log(`Clicking selector: ${selector}`);
              try {
                await page.click(selector); // normal click
                console.log(`Clicked selector: ${selector}`);
              } catch {
                console.warn("CSS click failed, trying fallback");
                // force click fallback
                await page.evaluate(sel => {
                  const el = document.querySelector(sel);
                  if (el) el.click();
                }, selector);
                console.log(`Fallback clicked selector: ${selector}`);
              }
            }

            await new Promise(r => setTimeout(r, click.wait || 300));
          }
        } catch (err) {
          console.warn(`Click failed: ${JSON.stringify(click)} ->`, err.message);
        }
        if (debug) {
          await page.screenshot({ path: `pics/after-click-${clicks.indexOf(click)}.png`, fullPage: true });
        }
      }
    }
    
    const html = await page.content();
    let responseJson = {};
    if (includeHeaders) {
      const headers = response.headers();
      responseJson.headers = headers;
    }
    if (includeCookies) {
      const cookies = await page.cookies();
      responseJson.cookies = cookies;
    }
    if (includeHeaders || includeCookies) {
      responseJson.html = html;
      res.set("Content-Type", "application/json; charset=utf-8");
      return res.send(JSON.stringify(responseJson));
    }

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
    })(), RENDER_DEADLINE_MS);
  } catch (err) {
    console.error("Render error:", err);
    if (!res.headersSent) res.status(500).send("Failed to render page");
  } finally {
    await closePage(page);
  }
});

// EXAMPLE RUN
  // {
  //   "url": "https://mikaylaarealike.com/e/zw8fogt8fgao",
  //   "timeout": 1000,
  //   "scripts": [
  //     "window.jwplayer?.().play()"
  //   ],
  //   "filters": {
  //     "include": [".m3u8"],
  //     "exclude": [".gif", "analytics"],
  //     "matchRegex": ".m3u8",
  //     "resourceTypes": ["xhr", "fetch"]
  //   }
  // }
app.post("/intercept", async (req, res) => {
  const {
    url,
    scripts = [],
    timeout = 10000,
    filters = {},
    headers = {}
  } = req.body;

  if (!url) return res.status(400).json({ error: "Missing 'url' field" });

  const { include = [], exclude = [], matchRegex = null, resourceTypes = [] } = filters;

  const browser = await browserPromise;
  const page = await browser.newPage();
  const captured = new Set();
  res.on("close", () => { if (!res.writableFinished) closePage(page); });

  try {
    await withDeadline((async () => {
    await page.setRequestInterception(true);

    // Apply optional per-request headers (e.g. Referer/Origin) to the whole
    // page before the initial navigation. Cloudflare's Turnstile "invisible"
    // challenge keys its solve to the Referer, so the caller passes the
    // player's expected origin and puppeteer sends it on the initial CDN
    // document and every subsequent request. Backward compatible: an absent or
    // empty object is a no-op, so existing callers (filmi9, etc.) are unchanged.
    // This is the request-header support the /render TODO describes, wired
    // into /intercept so bayflix can send its Referer.
    if (headers && Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    page.on("request", (reqIntercept) => {
      const u = reqIntercept.url();
      const type = reqIntercept.resourceType();

      // Only process resource types you specified (if any)
      if (resourceTypes.length > 0 && !resourceTypes.includes(type)) {
        return reqIntercept.continue();
      }

      // Apply include/exclude/regex filters dynamically
      const included = include.length === 0 || include.some(p => u.includes(p));
      const excluded = exclude.some(p => u.includes(p));
      const regexMatch = matchRegex ? new RegExp(matchRegex, "i").test(u) : true;

      if (included && !excluded && regexMatch) {
        console.log("🎯 Intercepted:", u);
        captured.add(u);
        reqIntercept.abort();
        return;
      }

      // Otherwise, continue request
      reqIntercept.continue();
    });

    console.log("🌐 Navigating:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // Run user scripts. A script that returns a Promise (e.g. bayflix's
    // time-delayed `new Promise(r => setTimeout(r, 10000))`) is awaited INSIDE
    // the evaluation so the capture window stays open for the script's full
    // duration. A plain `page.evaluate(fn, arg)` returns as soon as `fn`
    // returns — so a Promise-returning script would otherwise resolve
    // immediately and the window would close before a delayed
    // (Turnstile solve -> redirect -> .m3u8) request can be intercepted. The
    // async wrapper is deliberate: Puppeteer always awaits an async function's
    // result, and `await result` below holds that open until the inner Promise
    // settles. Non-Promise scripts resolve immediately (no behaviour change).
    for (const script of scripts) {
      try {
        console.log("⚙️ Executing script:", script);
        await page.evaluate(async (s) => {
          const result = eval(s);
          if (result && typeof result === "object" && typeof result.then === "function") {
            await result;
          }
          return result;
        }, script);
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.warn("⚠️ Script failed:", e.message);
      }
    }

    })(), RENDER_DEADLINE_MS);

    res.json({
      success: captured.size > 0,
      totalFound: captured.size,
      intercepted: [...captured]
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    await closePage(page);
  }
});

app.listen(3000, () => {
  console.log("Puppeteer render service running on port 3000");
});