import type { MetadataRoute } from "next";
import { SITE_URL, SITE_PRIVATE } from "@/lib/constants";

export default function sitemap(): MetadataRoute.Sitemap {
  if (SITE_PRIVATE) return [];
  const routes = ["/", "/about", "/help", "/sign-in", "/privacy", "/terms"];
  return routes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: new Date(),
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : 0.5,
  }));
}
