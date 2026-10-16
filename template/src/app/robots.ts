import type { MetadataRoute } from "next";
import { SITE_URL, SITE_PRIVATE } from "@/lib/constants";

export default function robots(): MetadataRoute.Robots {
  const rules = { userAgent: "*", allow: "/", disallow: ["/api/", "/settings", "/profile/", "/items", "/admin"] };
  // Private apps stay crawlable so bots can read the noindex tag (a Disallow would hide it); no sitemap.
  if (SITE_PRIVATE) return { rules };
  return { rules, sitemap: `${SITE_URL}/sitemap.xml` };
}
