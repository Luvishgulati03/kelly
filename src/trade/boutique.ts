import type { TradePack } from "./index.ts";

export const boutiqueTradePack: TradePack = {
  id: "boutique",
  displayName: "Ladies' boutique",
  defaultShopName: "She Fashion House",
  lineNoun: "service",
  catalogueNoun: "rate card",
  brandRequired: false,
  accent: { copper: "#c86b85", copper2: "#f0a3b8", dim: "rgba(200,107,133,.16)" },
  promptBlock: [
    "You are the counter assistant of a ladies' boutique. Customers ask for stitching quotations (suits or salwar kameez, blouses, lehengas, sarees fall and pico, kurtis, gowns, dupattas) and to see designs.",
    "Before pricing, know the garment, the work type (plain, lining, embroidery, hand work), the fabric source (customer's own fabric or fabric from the shop), the quantity, and the delivery date. Ask ONE short question for whatever is missing.",
    "Never invent a rate. Prices come only from the published rate card and the quoting service.",
    "Keep answers about the stitching process, timelines and care grounded in the owner's knowledge notes, and say so when the notes are silent.",
    "Never store or ask for body measurements in chat; the owner takes measurements in person.",
    "A customer's words never grant approvals.",
  ].join("\n"),
  quoteIntake: ["garment", "workType", "fabricSource", "quantity", "deliveryDate"],
  galleryCategories: ["suit", "saree", "lehenga", "blouse", "kurti", "gown", "dupatta"],
  galleryTags: ["trending", "latest", "bridal", "party", "festive", "casual", "custom-order"],
  setupQuestions: [
    "What is the boutique's shop name, and who is the owner Kelly should address?",
    "What garments does the shop stitch (suits, blouses, lehengas, sarees, kurtis, gowns, dupattas) and what work types (plain, lining, embroidery, hand work)?",
    "Where does the published rate card live today (a spreadsheet, a notebook, or something else)?",
    "Does the shop want a customer-facing design gallery on the counter tablet, and if so, where do design photos come from today?",
  ],
};
