from pathlib import Path
root = Path('.')
for path in root.rglob('*'):
    if path.is_file() and path.suffix not in {'.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.ico', '.woff', '.woff2', '.ttf'}:
        try:
            text = path.read_text(encoding='utf-8')
        except Exception:
            continue
        if '\uFFFD' in text:
            print(f"{path}")
