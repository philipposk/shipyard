import { HOME, type HomeContent } from "@/lib/home-content";
import { HomeActions } from "./parts";

/** One centred message, two buttons and three short points. */
export function HomeFocus({ content = HOME }: { content?: HomeContent }) {
  return (
    <div className="hm-focus">
      <section className="hm-focus-hero">
        <h1 className="hm-title">{content.headline}</h1>
        <p className="hm-sub">{content.subline}</p>
        <HomeActions content={content} />
      </section>
      <ul className="hm-points">
        {content.points.map((point) => (
          <li key={point.title} className="hm-point card card-pad">
            <h2 className="hm-point-title">{point.title}</h2>
            <p className="hm-point-text">{point.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
