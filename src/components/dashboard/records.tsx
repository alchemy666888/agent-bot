export function Records({
  title,
  items = [],
}: {
  title: string;
  items?: Record<string, unknown>[];
}) {
  return (
    <main>
      <h1>{title}</h1>
      <form className="search" role="search">
        <label htmlFor="search">Search {title.toLowerCase()}</label>
        <input id="search" name="search" />
        <button>Search</button>
      </form>
      <section className="card" aria-live="polite">
        {items.length ? (
          <ul className="records">
            {items.map((item, index) => (
              <li key={index}>
                <pre>{JSON.stringify(item, null, 2)}</pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No records found.</p>
        )}
      </section>
      <nav aria-label="Pagination">
        <span>Page 1</span>
      </nav>
    </main>
  );
}
