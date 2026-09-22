export default function Overview() {
  return (
    <main>
      <h1>Overview</h1>
      <p className="muted">
        Data is refreshed when this page is loaded or manually refreshed.
      </p>
      <section className="card">
        <h2>Persisted records</h2>
        <dl>
          <dt>Users</dt>
          <dd>0</dd>
          <dt>Conversations</dt>
          <dd>0</dd>
          <dt>Messages</dt>
          <dd>0</dd>
          <dt>Model runs</dt>
          <dd>0</dd>
          <dt>Errors</dt>
          <dd>0</dd>
        </dl>
      </section>
    </main>
  );
}
