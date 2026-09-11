/**
 * Turns an uploaded attachment into text the LLM can read.
 *
 * Routing:
 *  - PDF / DOCX / XLSX / CSV  → env.AI.toMarkdown()   (fast, no OCR, handles text-layer docs)
 *  - PNG / JPEG               → vision model OCR       (toMarkdown also uses a vision model
 *                                                        internally for images, but we call it
 *                                                        directly so we control the prompt)
 *  - Scanned PDF (toMarkdown returns ~empty)
 *                             → Browser Rendering fallback: launch headless Chromium, render
 *                                each page to an image with pdf.js, OCR each page image with
 *                                the vision model. Free tier: 10 min browser time/day — plenty
 *                                for a few orders/day.
 */

import puppeteer from "@cloudflare/puppeteer";

const TEXT_MARKDOWN_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.ms-excel",
  "text/csv",
]);

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export async function extractFromFile(file, env) {
  const name        = (file.name || "upload").toLowerCase();
  const contentType = file.type || guessTypeFromName(name);
  const bytes        = await file.arrayBuffer();

  if (IMAGE_TYPES.has(contentType) || /\.(png|jpe?g|webp)$/.test(name)) {
    return await ocrImage(bytes, env, name);
  }

  if (TEXT_MARKDOWN_TYPES.has(contentType) || /\.(pdf|docx|xlsx|xls|csv)$/.test(name)) {
    const isPdf = contentType === "application/pdf" || name.endsWith(".pdf");

    try {
      const [result] = await env.AI.toMarkdown([
        { name, blob: new Blob([bytes], { type: contentType || "application/octet-stream" }) },
      ]);
      const markdown = result?.data?.trim();

      if (markdown && markdown.length >= 20) {
        return { text: markdown, warning: null };
      }

      // No text layer found — automatically render pages and OCR them.
      if (isPdf) {
        if (!env.MYBROWSER) {
          return {
            text: null,
            warning: `"${file.name}" is a scanned PDF and automated rendering isn't configured on this deployment yet.`,
          };
        }
        return await ocrScannedPdf(bytes, env, file.name);
      }

      return { text: null, warning: `"${file.name}" produced no readable content.` };
    } catch (err) {
      return { text: null, warning: `Couldn't parse "${file.name}": ${err.message}` };
    }
  }

  return { text: null, warning: `Unsupported file type: "${file.name}". Supported: PDF, DOCX, XLSX, CSV, PNG, JPEG.` };
}

/**
 * Renders each page of a scanned PDF to a PNG inside headless Chromium
 * (using pdf.js loaded in-page), then OCRs each page image with the vision model.
 */
async function ocrScannedPdf(bytes, env, fileName) {
  const base64Pdf = arrayBufferToBase64(bytes);
  let browser;

  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();

    // Minimal page that loads pdf.js from CDN and exposes a render function
    await page.setContent(`
      <!DOCTYPE html><html><body>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.js"></script>
      </body></html>
    `);
    await page.waitForFunction(() => window.pdfjsLib !== undefined, { timeout: 15000 });

    const pageImages = await page.evaluate(async (base64) => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";

      const binary = atob(base64);
      const bytesArr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytesArr[i] = binary.charCodeAt(i);

      const pdf = await window.pdfjsLib.getDocument({ data: bytesArr }).promise;
      const images = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const pdfPage = await pdf.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 2 }); // higher scale = better OCR accuracy
        const canvas = document.createElement("canvas");
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        images.push(canvas.toDataURL("image/png").split(",")[1]); // strip data: prefix
      }
      return images;
    }, base64Pdf);

    await browser.close();

    if (!pageImages?.length) {
      return { text: null, warning: `Couldn't render any pages from "${fileName}".` };
    }

    const pageTexts = [];
    for (let i = 0; i < pageImages.length; i++) {
      const { text, warning } = await ocrImage(base64ToArrayBuffer(pageImages[i]), env, `${fileName} (page ${i + 1})`);
      if (text) pageTexts.push(`--- Page ${i + 1} ---\n${text}`);
      else if (warning) pageTexts.push(`--- Page ${i + 1} (unreadable) ---`);
    }

    if (pageTexts.length === 0) {
      return { text: null, warning: `Rendered "${fileName}" but couldn't read any text from its pages.` };
    }
    return { text: pageTexts.join("\n\n"), warning: null };
  } catch (err) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return {
      text: null,
      warning: `Couldn't automatically process "${fileName}" (${err.message}). Please try again in a moment.`,
    };
  }
}

async function ocrImage(bytes, env, name) {
  const base64 = arrayBufferToBase64(bytes);

  const response = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "This image is a purchase order or invoice. Transcribe ALL visible text exactly as " +
              "it appears — headers, line items, quantities, prices, dates, vendor/customer names, " +
              "totals — preserving structure with line breaks. Do not summarize or omit anything.",
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      },
    ],
  });

  const text = response?.response?.trim();
  if (!text) return { text: null, warning: `Couldn't read any text from "${name}".` };
  return { text, warning: null };
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function guessTypeFromName(name) {
  if (name.endsWith(".pdf"))  return "application/pdf";
  if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (name.endsWith(".csv"))  return "text/csv";
  return "";
}
