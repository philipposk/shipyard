// The words on /privacy and /terms. Shipyard's `legal-generate` script rewrites this whole file from your
// profile, the services your app uses and your plans. Keep the three exports below; the pages read them.
// This starter text only covers what a new app does: accounts, a profile, saved items, a database and hosting.
import type { LegalController, LegalSection } from "@/lib/legal-types";

/** The day this text was written (YYYY-MM-DD). */
export const updatedAt = "2026-10-16";

/**
 * Who is responsible for the app. While `name` is empty the pages show the app name, and while `email` is empty
 * they show NEXT_PUBLIC_CONTACT_EMAIL. The admin Health page flags every empty field.
 */
export const controller: LegalController = { name: "", address: "", email: "", country: "" };

export const privacy: LegalSection[] = [
  {
    id: "what-we-collect",
    title: "What we collect",
    paragraphs: [
      "Your email address and a password. We never see your password in plain text.",
      "The profile details you enter, such as a display name and a short bio.",
      "What you save in the app.",
      "Basic technical information that comes with every visit, such as your IP address and browser type. We use it to keep the app secure and to find faults.",
    ],
  },
  {
    id: "why-we-use-it",
    title: "Why we use it",
    paragraphs: [
      "To give you an account and run the app for you. This is the agreement between you and us.",
      "To keep the app secure and working. This is our legitimate interest in running a safe service.",
      "We do not sell your data and we do not use it for advertising.",
    ],
  },
  {
    id: "who-processes-your-data",
    title: "Who processes your data",
    paragraphs: ["We use these companies to run the app. They handle your data only on our behalf."],
    table: {
      headers: ["Company", "What it does", "Data it handles"],
      rows: [
        ["Supabase", "Stores accounts and everything you save, and handles sign-in", "Email, password (scrambled), profile, saved items"],
        ["Vercel", "Hosts the app and delivers its pages", "Technical information about each visit"],
      ],
    },
  },
  {
    id: "how-long-we-keep-it",
    title: "How long we keep it",
    paragraphs: [
      "We keep your data while your account exists. When you delete your account in Settings, your account and what you saved are removed.",
      "Our hosting provider keeps technical logs for a short time, then removes them.",
    ],
  },
  {
    id: "your-rights",
    title: "Your rights",
    paragraphs: [
      "You can ask to see your data, correct it or have it deleted. You can delete your account yourself at any time in Settings.",
      "You can ask us for a copy of your data by email.",
      "If you think we handle your data wrongly, you can complain to the data protection authority in your country.",
    ],
  },
  {
    id: "cookies",
    title: "Cookies",
    paragraphs: [
      "We use only the cookies the app needs: one to keep you signed in and one to remember your choices, such as light or dark mode. There is no advertising or tracking cookie.",
    ],
  },
  {
    id: "children",
    title: "Children",
    paragraphs: ["This app is not meant for children under 16. If you think a child has made an account, contact us and we will delete it."],
  },
  {
    id: "changes",
    title: "Changes",
    paragraphs: ["If we change this policy, the date at the top changes. For big changes we will tell you in the app or by email."],
  },
  {
    id: "contact",
    title: "Contact",
    paragraphs: ["Questions about your data? Use the contact details at the top of this page, or ask the person who runs the app."],
  },
];

export const terms: LegalSection[] = [
  {
    id: "the-service",
    title: "The service",
    paragraphs: ["These terms apply when you use this app. By creating an account or using the app, you agree to them."],
  },
  {
    id: "your-account",
    title: "Your account",
    paragraphs: [
      "Give a real email address and keep your password to yourself. You are responsible for what happens in your account.",
      "You can delete your account at any time in Settings.",
    ],
  },
  {
    id: "fair-use",
    title: "Fair use",
    paragraphs: [
      "Use the app within the law. Do not try to break it, get into other people's accounts, or overload it.",
      "We can suspend an account that breaks these rules.",
    ],
  },
  {
    id: "your-content",
    title: "What you save",
    paragraphs: [
      "What you save in the app stays yours. You give us permission to store it and show it back to you, only to run the app.",
      "Do not save anything you have no right to save.",
    ],
  },
  {
    id: "availability",
    title: "Availability",
    paragraphs: ["We work to keep the app running, but we do not promise it will always be available or free of faults. We may change or stop features."],
  },
  {
    id: "liability",
    title: "Liability",
    paragraphs: [
      "The app is provided as it is. As far as the law allows, we are not liable for losses that come from using it.",
      "Nothing here limits rights you have by law that cannot be limited.",
    ],
  },
  {
    id: "governing-law",
    title: "Governing law",
    paragraphs: ["These terms follow the law of the country where the person or company named at the top of this page is based."],
  },
  {
    id: "changes-to-terms",
    title: "Changes",
    paragraphs: ["If we change these terms, the date at the top changes. If you keep using the app after a change, you accept the new terms."],
  },
  {
    id: "contact-us",
    title: "Contact",
    paragraphs: ["Questions about these terms? Use the contact details at the top of this page, or ask the person who runs the app."],
  },
];
