import type { MetadataRoute } from "next";

const SITE = "https://agent-task-board.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
