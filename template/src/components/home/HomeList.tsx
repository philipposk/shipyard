import Link from "next/link";
import { HOME, type HomeContent } from "@/lib/home-content";
import { Chevron, HomeTile } from "./parts";

/** An app-style start screen: a title, two quick actions and a list of places to go. */
export function HomeList({ content = HOME }: { content?: HomeContent }) {
  return (
    <div>
      <section className="hm-list-head">
        <h1 className="hm-list-title">{content.headline}</h1>
        <p className="hm-sub">{content.subline}</p>
        <div className="hm-quick">
          <Link href={content.ctaPrimary.href} className="btn btn-primary">
            {content.ctaPrimary.label}
          </Link>
          <Link href={content.ctaSecondary.href} className="btn btn-secondary">
            {content.ctaSecondary.label}
          </Link>
        </div>
      </section>
      <ul className="card hm-rows">
        {content.entries.map((entry) => (
          <li key={entry.href}>
            <Link href={entry.href} className="hm-row">
              <HomeTile icon={entry.icon} />
              <span className="hm-row-body">
                <span className="hm-row-title">{entry.title}</span>
                <span className="hm-row-blurb">{entry.blurb}</span>
              </span>
              <Chevron />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
