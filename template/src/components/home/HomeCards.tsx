import Link from "next/link";
import { HOME, type HomeContent } from "@/lib/home-content";
import { Arrow, HomeActions, HomeTile } from "./parts";

/** A short welcome, then a grid of three to six places to go. */
export function HomeCards({ content = HOME }: { content?: HomeContent }) {
  return (
    <div>
      <section className="hm-cards-head">
        <h1 className="hm-title">{content.headline}</h1>
        <p className="hm-sub">{content.subline}</p>
        <HomeActions content={content} />
      </section>
      <ul className="hm-grid">
        {content.entries.slice(0, 6).map((entry) => (
          <li key={entry.href}>
            <Link href={entry.href} className="card hm-card">
              <HomeTile icon={entry.icon} />
              <h2 className="hm-card-title">{entry.title}</h2>
              <p className="hm-card-text">{entry.blurb}</p>
              <span className="hm-card-go">
                Open
                <Arrow />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
