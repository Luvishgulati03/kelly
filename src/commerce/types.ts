export type SourceKind = "pdf" | "xlsx" | "csv" | "manual";

export interface CatalogueProductInput {
  sku: string;
  brand: string;
  name: string;
  category: string;
  specification?: string;
  unit?: string;
  packSize?: number;
  pricePaise: number;
  gstBasisPoints?: number;
  taxInclusive?: boolean;
  sourceLocation: string;
}

export interface CatalogueProduct extends CatalogueProductInput {
  id: string;
  documentId: string;
  status: "pending" | "published";
  importedAt: string;
}

export interface QuoteRequestLine {
  sku?: string;
  query?: string;
  quantity: string | number;
  lineDiscountBasisPoints?: number;
}

export interface QuoteRequest {
  customerName?: string;
  /** Required unless the active trade pack sets brandRequired:false, in which case
   * CommerceService.createQuote defaults it to the shop name (or "house"). */
  brand?: string;
  lines: QuoteRequestLine[];
  basketDiscountBasisPoints?: number;
  validDays?: number;
}

export interface CalculatedQuoteLine {
  productId: string;
  sku: string;
  brand: string;
  name: string;
  quantityMilli: number;
  unit: string;
  unitPricePaise: number;
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  evidence: string;
}

export interface CalculatedQuote {
  id: string;
  version: number;
  brand: string;
  customerName?: string;
  complete: boolean;
  unresolved: QuoteRequestLine[];
  lines: CalculatedQuoteLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  createdAt: string;
  validUntil: string;
}
