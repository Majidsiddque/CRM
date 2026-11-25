# Contributing to CRM

Thank you for your interest in contributing to this project! 🎉

## Development Setup

1. **Prerequisites**
   - Node.js 22.9+
   - Docker (running)
   - Git

2. **Local Setup**
   ```bash
   git clone https://github.com/Salonikori/CRM.git
   cd CRM
   npm install
   npm run dev
   ```

## Development Workflow

1. Create a new branch for your feature:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and test:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

3. Commit your changes:
   ```bash
   git add .
   git commit -m "feat: your feature description"
   ```

4. Push and create a pull request:
   ```bash
   git push origin feature/your-feature-name
   ```

## Code Style

- Follow the existing code style
- Run `npm run lint` before committing
- Ensure all tests pass with `npm test`

## Testing

- Add tests for new features
- Run the full test suite: `npm test`
- Run isolation tests: `npm run test:isolation`

## Questions?

Feel free to open an issue for any questions or concerns!
