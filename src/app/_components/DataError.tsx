export default function DataError({ error, dataDir }: { error: string; dataDir: string }) {
  return (
    <section className="state" role="alert">
      <p className="eyebrow">Data unavailable</p>
      <h1>The answers could not be loaded.</h1>
      <p className="muted">
        Nothing is shown rather than a partial or misleading picture. Point <code>DATA_DIR</code> at the folder that
        contains the responses file, brands.json, facts.json and prompts.csv, then reload.
      </p>
      <pre>{`DATA_DIR=${dataDir}\n\n${error}`}</pre>
    </section>
  );
}
