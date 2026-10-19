import { HOME, type HomeContent } from "@/lib/home-content";
import { HomeActions, HomePreview } from "./parts";

/** Words on the left, a picture of the app on the right, then the three points as cards. Stacks on phones. */
export function HomeSplit({ content = HOME }: { content?: HomeContent }) {
  return (
    <div className="hm-split-wrap">
      <div className="hm-split">
        <section className="hm-split-text">
          <h1 className="hm-title">{content.headline}</h1>
          <p className="hm-sub">{content.subline}</p>
          <HomeActions content={content} />
        </section>
        {/* A picture of the app (sample rows in a browser window). Nothing in it can be clicked. */}
        <HomePreview content={content} />
      </div>
      <ul className="hm-points hm-split-points">
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
