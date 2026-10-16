import Link from "next/link";
import { HOME, type HomeContent } from "@/lib/home-content";
import { HomeActions } from "./parts";

/** A large headline, an intro and a contents list that reads like articles. */
export function HomeEditorial({ content = HOME }: { content?: HomeContent }) {
  return (
    <div className="hm-editorial">
      <section>
        <h1 className="hm-display">{content.headline}</h1>
        <p className="hm-lede">{content.subline}</p>
        <HomeActions content={content} />
      </section>
      <ol className="hm-articles">
        {content.entries.map((entry) => (
          <li key={entry.href} className="hm-article">
            <p className="hm-kicker">{entry.kicker}</p>
            <h2 className="hm-article-title">
              <Link href={entry.href}>{entry.title}</Link>
            </h2>
            <p className="hm-article-blurb">{entry.blurb}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
