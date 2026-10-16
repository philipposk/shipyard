/** Grey placeholder shapes shown while data loads. Match the final layout so the page does not jump. */
export function CardSkeleton() {
  return (
    <div className="card card-pad space-y-3" aria-hidden="true">
      <div className="skeleton h-6 w-2/3" />
      <div className="skeleton h-4 w-full" />
      <div className="skeleton h-4 w-5/6" />
    </div>
  );
}

export function ListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="card" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="list-row">
          <div className="skeleton h-5 w-1/2" />
        </div>
      ))}
    </div>
  );
}
