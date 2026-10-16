/** One part of a legal page: a heading, some paragraphs and (optionally) a table. */
export interface LegalSection {
  /** Lowercase letters, numbers and dashes. Becomes the anchor: /privacy#who-processes-your-data */
  id: string;
  title: string;
  paragraphs: string[];
  table?: { headers: string[]; rows: string[][] };
}

/** Who is responsible for the app. Any empty field is flagged on the admin Health page. */
export interface LegalController {
  name: string;
  address: string;
  email: string;
  country: string;
  /** Only when the app sells to consumers and the owner has a phone number. */
  phone?: string;
}

export interface LegalContent {
  /** The day the text was last written, as YYYY-MM-DD. */
  updatedAt: string;
  controller: LegalController;
  privacy: LegalSection[];
  terms: LegalSection[];
}
