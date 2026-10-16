import { HOME, type HomeContent } from "@/lib/home-content";
import { HomeActions } from "./parts";

/** Words on the left, a small preview of the app on the right. Stacks on phones. */
export function HomeSplit({ content = HOME }: { content?: HomeContent }) {
  const rows = content.entries.slice(0, 3);
  return (
    <div className="hm-split-wrap">
      <div className="hm-split">
        <section className="hm-split-text">
          <h1 className="hm-title">{content.headline}</h1>
          <p className="hm-sub">{content.subline}</p>
          <HomeActions content={content} />
        </section>
        {/* A picture of the app, built from its own pieces. Nothing in it can be clicked. */}
        <div className="card hm-preview" aria-hidden="true" inert>
          <div className="hm-preview-head">
            <h2 className="hm-preview-title">Items</h2>
          </div>
          <div className="hm-preview-add">
            <div className="input hm-preview-field">Add an item</div>
            <span className="btn btn-primary">Add</span>
          </div>
          <ul className="hm-preview-list">
            {rows.map((row) => (
              <li key={row.title} className="list-row">
                <span className="hm-dot" />
                <span className="hm-preview-row-title">{row.title}</span>
                <span className="hm-preview-row-meta">{row.kicker}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
