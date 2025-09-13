import puppeteer from "puppeteer";
import fs from "fs-extra";
import { setTimeout } from "timers/promises";
import path from "path";
import fetch from "node-fetch";

const DOWNLOAD_DIR = "./downloads";

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

// Helper function to create error content
function createErrorContent(
   videoUrl,
   videoId,
   errorMessage,
   errorType = "Unknown"
) {
   return `Video URL: ${videoUrl}
Video ID: ${videoId}
Error Type: ${errorType}
Error Message: ${errorMessage}
Timestamp: ${new Date().toISOString()}
Playlist URL: ${process.argv[2] || "Unknown"}`;
}

// Helper function to debug page content
async function debugPageContent(page, videoTitle) {
   try {
      // Take screenshot for debugging
      const screenshotPath = path.join(
         DOWNLOAD_DIR,
         `debug_${videoTitle}_${Date.now()}.png`
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Debug screenshot saved: ${screenshotPath}`);

      // Get page HTML for debugging
      const htmlContent = await page.content();
      const htmlPath = path.join(
         DOWNLOAD_DIR,
         `debug_${videoTitle}_${Date.now()}.html`
      );
      await fs.writeFile(htmlPath, htmlContent);
      console.log(`Debug HTML saved: ${htmlPath}`);

      // Log all available buttons
      const buttons = await page.evaluate(() => {
         const buttonElements = document.querySelectorAll("button");
         return Array.from(buttonElements).map((btn) => ({
            text: btn.textContent?.trim(),
            title: btn.getAttribute("data-title"),
            className: btn.className,
         }));
      });
      console.log("Available buttons:", buttons);
   } catch (error) {
      console.log("Debug failed:", error.message);
   }
}

async function setupBrowser() {
   for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
         console.log(
            `Setting up browser (attempt ${attempt}/${MAX_RETRIES})...`
         );

         const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
               "--start-maximized", // Open window in full size
               "--no-sandbox",
               "--disable-setuid-sandbox",
               "--disable-dev-shm-usage",
               "--disable-accelerated-2d-canvas",
               "--no-first-run",
               "--no-zygote",
               "--disable-gpu",
            ],
            protocolTimeout: 60000, // Increase protocol timeout to 60 seconds
            timeout: 60000, // Increase launch timeout to 60 seconds
         });

         const page = await browser.newPage();

         // Set viewport to maximum size
         await page.setViewport({
            width: 1920,
            height: 1080,
         });

         // Ensure download directory exists
         await fs.ensureDir(DOWNLOAD_DIR);

         // Add timeout for CDP session creation
         const client = await Promise.race([
            page.target().createCDPSession(),
            new Promise((_, reject) =>
               setTimeout(
                  () => reject(new Error("CDP session creation timeout")),
                  30000
               )
            ),
         ]);

         await client.send("Page.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: path.resolve(DOWNLOAD_DIR),
         });

         console.log("Browser setup successful!");
         return { browser, page };
      } catch (error) {
         console.error(
            `Browser setup attempt ${attempt} failed:`,
            error.message
         );

         if (attempt === MAX_RETRIES) {
            throw new Error(
               `Failed to setup browser after ${MAX_RETRIES} attempts: ${error.message}`
            );
         }

         console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`);
         await setTimeout(RETRY_DELAY);
      }
   }
}

async function getPlaylistVideos(playlistUrl) {
   try {
      const browser = await puppeteer.launch({
         headless: true,
         defaultViewport: {
            width: 1920,
            height: 1080,
         },
         args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu",
         ],
         protocolTimeout: 60000,
         timeout: 60000,
      });
      const page = await browser.newPage();
      await page.setViewport({
         width: 1920,
         height: 1080,
      });
      await page.goto(playlistUrl, {
         waitUntil: "networkidle2",
         timeout: 30000,
      });

      // Wait for video list to load
      await page.waitForSelector('a[href*="watch?v="]');

      // Scroll to load all videos in the playlist
      let previousHeight = 0;
      let currentHeight = 0;
      let scrollTries = 0;
      do {
         previousHeight = await page.evaluate(
            "document.documentElement.scrollHeight"
         );
         await page.evaluate(
            "window.scrollTo(0, document.documentElement.scrollHeight)"
         );
         await setTimeout(1500);
         currentHeight = await page.evaluate(
            "document.documentElement.scrollHeight"
         );
         scrollTries++;
      } while (currentHeight > previousHeight && scrollTries < 50);

      // Lấy tất cả URL video trong playlist
      const videoUrls = await page.evaluate(() => {
         const links = document.querySelectorAll('a[href*="watch?v="]');
         const urls = new Set(); // Use Set to remove duplicates
         links.forEach((link) => {
            const url = new URL(link.href);
            // Only get URLs with format watch?v=
            if (url.searchParams.has("v")) {
               urls.add(url.href);
            }
         });
         return Array.from(urls);
      });

      await browser.close();
      return videoUrls;
   } catch (error) {
      console.error("Error while fetching video list from playlist:", error);
      return [];
   }
}

async function getYouTubeTitle(url) {
   try {
      const videoId = url.split("v=")[1].split("&")[0];
      const response = await fetch(
         `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${videoId}&format=json`
      );
      const data = await response.json();
      // Remove invalid characters from file name
      return data.title.replace(/[<>:"/\\|?*-]/g, "_");
   } catch (error) {
      console.error("Error while fetching video title:", error);
      return "unknown_title";
   }
}

async function getVideoId(url) {
   try {
      return url.split("v=")[1].split("&")[0];
   } catch (error) {
      return "unknown";
   }
}

async function checkFileExists(videoTitle, videoId) {
   try {
      const successFilePath = path.join(DOWNLOAD_DIR, `${videoTitle}.txt`);
      const errorFilePath = path.join(
         DOWNLOAD_DIR,
         `error_${videoTitle}_${videoId}.txt`
      );

      // Check if success file exists
      if (await fs.pathExists(successFilePath)) {
         return { exists: true, type: "success", filePath: successFilePath };
      }

      // Check if error file exists
      if (await fs.pathExists(errorFilePath)) {
         return { exists: true, type: "error", filePath: errorFilePath };
      }

      return { exists: false, type: null, filePath: null };
   } catch (error) {
      console.error(`Error checking file existence for ${videoTitle}:`, error);
      return { exists: false, type: null, filePath: null };
   }
}

async function getTranscript(page, videoUrl) {
   try {
      const videoTitle = await getYouTubeTitle(videoUrl);
      const videoId = await getVideoId(videoUrl);

      // Check if file already exists
      const fileCheck = await checkFileExists(videoTitle, videoId);
      if (fileCheck.exists) {
         if (fileCheck.type === "success") {
            console.log(`[SKIP] Video already downloaded: ${videoTitle}`);
            return {
               status: "skipped",
               reason: "already_downloaded",
               videoTitle,
            };
         } else if (fileCheck.type === "error") {
            console.log(`[SKIP] Video previously failed: ${videoTitle}`);
            return {
               status: "skipped",
               reason: "previously_failed",
               videoTitle,
            };
         }
      }

      console.log(`Processing video: ${videoTitle}`);

      // Go to downsub.com
      await page.goto("https://downsub.com/");
      await page.waitForSelector('input[name="url"]');

      // Enter video URL
      await page.type('input[name="url"]', videoUrl);

      // Click search button
      await page.click('button[type="submit"]');

      // Wait up to 30 seconds for transcript buttons
      try {
         console.log("Waiting for transcript buttons...");

         // Wait for any transcript-related button to appear
         await page.waitForSelector(
            'button[data-title*="Vietnamese"], button[data-title*="RAW"], button[data-title*="Transcript"]',
            {
               timeout: 30000,
            }
         );

         // Try to find and click Vietnamese transcript button
         let clicked = false;
         const buttonSelectors = [
            'button[data-title*="[RAW] Vietnamese"]',
            'button[data-title*="Vietnamese"]',
            'button[data-title*="RAW"]',
            'button[data-title*="Transcript"]',
         ];

         for (const selector of buttonSelectors) {
            try {
               const button = await page.$(selector);
               if (button) {
                  console.log(`Clicking button with selector: ${selector}`);
                  await button.click();
                  clicked = true;
                  break;
               }
            } catch (e) {
               continue;
            }
         }

         if (!clicked) {
            // Try to click any button that might be transcript-related
            const allButtons = await page.$$("button");
            for (let button of allButtons) {
               const text = await button.evaluate((el) =>
                  el.textContent?.trim()
               );
               const title = await button.evaluate((el) =>
                  el.getAttribute("data-title")
               );

               if (
                  text &&
                  (text.includes("Vietnamese") ||
                     text.includes("RAW") ||
                     text.includes("Transcript"))
               ) {
                  console.log(`Clicking button with text: ${text}`);
                  await button.click();
                  clicked = true;
                  break;
               }
            }
         }

         // Wait longer for content to appear and try multiple approaches
         console.log("Waiting for content to load...");
         await setTimeout(5000); // Wait 5 seconds for content to appear

         // Try to scroll to ensure content is visible
         await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
         });
         await setTimeout(2000);

         // Try multiple selectors to find content
         let textContent = null;
         const selectors = [
            "pre",
            ".subtitle-content",
            ".transcript-content",
            "[data-testid='transcript-content']",
            ".subtitle-text",
            "div[class*='subtitle']",
            "div[class*='transcript']",
         ];

         for (const selector of selectors) {
            try {
               const element = await page.$(selector);
               if (element) {
                  textContent = await page.$eval(
                     selector,
                     (el) => el.textContent
                  );
                  if (textContent && textContent.trim().length > 0) {
                     console.log(`Found content using selector: ${selector}`);
                     break;
                  }
               }
            } catch (e) {
               // Continue to next selector
               continue;
            }
         }

         // If still no content, try to get all text from the page
         if (!textContent || textContent.trim().length === 0) {
            console.log("Trying to get all page text...");
            textContent = await page.evaluate(() => {
               // Look for any element that might contain transcript
               const possibleElements =
                  document.querySelectorAll("div, pre, p, span");
               for (let el of possibleElements) {
                  const text = el.textContent || el.innerText;
                  if (text && text.length > 100 && text.includes(" ")) {
                     return text;
                  }
               }
               return null;
            });
         }

         if (textContent && textContent.trim().length > 0) {
            // Save content to file
            const filePath = path.join(DOWNLOAD_DIR, `${videoTitle}.txt`);
            await fs.writeFile(filePath, textContent);
            console.log(`Transcript saved for video: ${videoTitle}`);
            return { status: "success", videoTitle };
         } else {
            // Debug page content when content not found
            console.log("Content not found, debugging page...");
            await debugPageContent(page, videoTitle);

            // Save error info to file
            const errorPath = path.join(
               DOWNLOAD_DIR,
               `error_${videoTitle}_${videoId}.txt`
            );
            const errorContent = createErrorContent(
               videoUrl,
               videoId,
               "Transcript content not found after trying multiple selectors",
               "No Content"
            );
            await fs.writeFile(errorPath, errorContent);
            console.log(
               `Transcript content not found for video: ${videoTitle}`
            );
            return { status: "error", reason: "no_content", videoTitle };
         }
      } catch (error) {
         // Save error info to file
         const errorPath = path.join(
            DOWNLOAD_DIR,
            `error_${videoTitle}_${videoId}.txt`
         );
         const errorContent = createErrorContent(
            videoUrl,
            videoId,
            error.message,
            "Transcript Not Found"
         );
         await fs.writeFile(errorPath, errorContent);
         console.log(
            `Vietnamese transcript not found for video: ${videoTitle}`
         );
         return { status: "error", reason: "transcript_not_found", videoTitle };
      }
   } catch (error) {
      const videoId = await getVideoId(videoUrl);
      const errorPath = path.join(DOWNLOAD_DIR, `error_unknown_${videoId}.txt`);
      const errorContent = createErrorContent(
         videoUrl,
         videoId,
         error.message,
         "Unknown Error"
      );
      await fs.writeFile(errorPath, errorContent);
      console.error(`Error processing video ${videoUrl}:`, error.message);
      return {
         status: "error",
         reason: "unknown_error",
         videoTitle: "unknown",
      };
   }
}

async function main() {
   // Require user to input playlist URL
   if (process.argv.length < 3) {
      console.log("Please provide a YouTube playlist URL. Example:");
      console.log(
         "node src/index.js https://www.youtube.com/playlist?list=xxx"
      );
      process.exit(1);
   }

   const playlistUrl = process.argv[2];
   console.log("Fetching video list from playlist...");
   const videoUrls = await getPlaylistVideos(playlistUrl);

   if (videoUrls.length === 0) {
      console.log("No videos found in the playlist.");
      process.exit(1);
   }

   // Highlight total video count
   console.log(
      `[1m[36m==============================\nFound ${videoUrls.length} videos in the playlist.\n==============================[0m`
   );

   let browser, page;
   try {
      const browserSetup = await setupBrowser();
      browser = browserSetup.browser;
      page = browserSetup.page;
   } catch (error) {
      console.error("Failed to setup browser:", error.message);
      console.log("Please try again. If the problem persists, try:");
      console.log("1. Restart your computer");
      console.log("2. Check if Chrome/Chromium is installed");
      console.log("3. Try running with: sudo node src/index.js <playlist_url>");
      process.exit(1);
   }

   // Track processing results
   let processedCount = 0;
   let successCount = 0;
   let errorCount = 0;
   let skippedCount = 0;
   const skippedVideos = [];

   try {
      for (const videoUrl of videoUrls) {
         const result = await getTranscript(page, videoUrl);
         processedCount++;

         if (result.status === "success") {
            successCount++;
         } else if (result.status === "error") {
            errorCount++;
         } else if (result.status === "skipped") {
            skippedCount++;
            skippedVideos.push({
               title: result.videoTitle,
               reason: result.reason,
            });
         }

         await setTimeout(2000); // Wait between videos to avoid overload
      }
   } finally {
      if (browser) {
         await browser.close();
      }
   }

   // Show summary
   const files = await fs.readdir(DOWNLOAD_DIR);
   const successFiles = files.filter((file) => !file.startsWith("error_"));
   const errorFiles = files.filter((file) => file.startsWith("error_"));

   console.log("\n=== Summary ===");
   console.log(`Total videos in playlist: ${videoUrls.length}`);
   console.log(`Processed: ${processedCount}`);
   console.log(`Successfully downloaded: ${successCount}`);
   console.log(`Failed: ${errorCount}`);
   console.log(`Skipped (already exists): ${skippedCount}`);

   if (skippedVideos.length > 0) {
      console.log("\n=== Skipped Videos ===");
      skippedVideos.forEach((video, index) => {
         const reasonText =
            video.reason === "already_downloaded"
               ? "Already downloaded"
               : "Previously failed";
         console.log(`${index + 1}. ${video.title} (${reasonText})`);
      });
   }
}

main().catch(console.error);
