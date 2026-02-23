# Testing

## Quick Checks

- `npm run build`
- `npm test`

## CI Workflow

GitHub Actions runs the following on every push to `main` and on pull requests:

- `npm ci`
- `npm run build`
- `npm test`

## Notes

- Unit tests use Vitest and do not require Canvas credentials.
- Integration testing against a real Canvas instance is intentionally out of CI scope.
