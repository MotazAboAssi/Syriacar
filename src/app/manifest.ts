import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "سيرياكار",
    short_name: "سيرياكار",
    description: "الأساس التقني لتطبيق سيرياكار.",
    id: "/",
    start_url: "/",
    scope: "/",
    lang: "ar",
    dir: "rtl",
    display: "standalone",
    background_color: "#F8FAFC",
    theme_color: "#166534",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}