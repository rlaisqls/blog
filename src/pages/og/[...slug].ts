import { type CollectionEntry, getCollection } from "astro:content";
import { OGImageRoute } from 'astro-og-canvas'

const entries = await getCollection('docs')
const pages = Object.fromEntries(entries.map(({ data, body, id }) => [id, { data, body }]))

export const { getStaticPaths, GET } = OGImageRoute({
  pages,
  param: 'slug',
  getImageOptions: (_path, page: (typeof pages)[number]) => {
    return {
      title: page.data.title,
      description: page.body
        .replace(/>\s|#|- |import.*?;|<[^>]*>?/g, "")
        .replace(/\`\`\`/g, "")
        .replace(/\*\*/g, "")
        .replace(/https:\/\/\S+/g, "")
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
        .replace(/\n/g, " ")
        .slice(0, 162) + "...",
      bgGradient: [[24, 24, 27]],
      border: { color: [63, 63, 70], width: 20 },
      padding: 120,
      font: {
        title: {
          color: [255, 255, 255],
          size: 45,
          families: ['Pretendard Variable'],
          weight: 'SemiBold',
        },
        description: {
          color: [255, 255, 255],
          size: 35,
          lineHeight: 1.85,
          families: ['Pretendard Variable'],
          weight: 'Normal',
        },
      },
      fonts: [
        'https://raw.githubusercontent.com/orioncactus/pretendard/82b96cc92998eb1f5e60e40beb6d52cd136957a6/packages/pretendard/dist/public/variable/PretendardVariable.ttf',
      ],
    }
  },
})