export function FullScreenLoader(): JSX.Element {
  return (
    <div className="full-screen-loader">
      <div className="spinner" aria-hidden />
      <p>Loading…</p>
    </div>
  );
}
