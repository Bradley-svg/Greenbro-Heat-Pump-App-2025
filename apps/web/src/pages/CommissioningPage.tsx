export function CommissioningPage(): JSX.Element {
  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Commissioning</h2>
          <p className="page__subtitle">Track installs and punch-list items</p>
        </div>
      </header>
      <section className="card">
        <h3>Next up</h3>
        <p>
          This space is ready for the commissioning workflow—drop in your checklists, upload flows, and integrate with the Worker
          APIs when they land. The layout and routing are wired, so you can connect forms and tables without touching the app
          shell.
        </p>
      </section>
    </div>
  );
}
