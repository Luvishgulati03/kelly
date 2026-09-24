import type { TradePack } from "./index.ts";

export const electricalTradePack: TradePack = {
  id: "electrical",
  displayName: "Electrical shop",
  defaultShopName: "Kelly's counter",
  lineNoun: "product",
  catalogueNoun: "catalogue",
  brandRequired: true,
  accent: { copper: "#d08a4b", copper2: "#f0b072", dim: "rgba(208,138,75,.16)" },
  greeting: "Namaste, welcome to <shop>. Boliye, what do you need today?",
  reprompt: "I am here. Tell me the item and quantity.",
  fillers: ["One moment, let me check.", "Ek second, checking the catalogue.", "Just a moment, almost there."],
  promptBlock: [
    "Your job is to turn customer requirements into traceable multi-brand quotations. Never invent a product, specification, price, tax, stock status or equivalence.",
    "Be concise, direct and useful. Ask only the smallest clarification needed to resolve ambiguous quantity, rating, brand or compatibility.",
  ].join("\n"),
  quoteIntake: ["item", "rating", "quantity", "brand"],
  galleryCategories: [],
  galleryTags: [],
  vocabulary: [
    "MCB", "RCCB", "Havells", "Polycab", "Finolex", "Anchor", "sqmm", "ampere",
    "socket", "switch", "wire", "cable", "bulb", "fan", "meter",
  ],
  aliases: {},
  setupQuestions: [
    "What products or categories does the shop sell (e.g. wiring, switches, fans, lighting)?",
    "Which brands does the shop carry, and is there a preferred or default brand?",
    "Does the shop offer bulk or contractor pricing that Kelly should know about?",
    "Where does the published catalogue live today (a spreadsheet, a supplier PDF, or something else)?",
  ],
};
