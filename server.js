import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

app.post("/render", async (req, res) => {
  const { url, clicks } = req.body;

  if (!url) {
    return res.status(400).send("Missing url");
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2" });

    // If we got clicks, execute them in sequence
    if (Array.isArray(clicks)) {
      for (const click of clicks) {
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
            if (selector.startsWith("xpath/")) {
              const xpath = selector.replace("xpath/", "");
              await page.waitForXPath(xpath, { timeout: 5000 });
              const [el] = await page.$x(xpath);
              if (el) await el.click();
            } else {
              await page.waitForSelector(selector, { timeout: 5000 });
              await page.click(selector);
            }

            await page.waitForTimeout(click.wait || 2000);
          }
        } catch (err) {
          console.warn(`Click failed: ${JSON.stringify(click)} ->`, err.message);
        }
      }
    }

    const html = await page.content();

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);

  } catch (err) {
    console.error("Render error:", err);
    res.status(500).send("Failed to render page");
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(3000, () => {
  console.log("Puppeteer render service running on port 3000");
});
