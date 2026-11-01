import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
  {
    // The rules engine must stay pure: no UI, rendering, network, database or Node APIs.
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*', 'react/*', '@react-three/*', 'three', 'three/*'], message: 'El motor no puede depender de la interfaz.' },
            { group: ['socket.io*', 'fastify*', 'pg', 'drizzle-orm*'], message: 'El motor no puede depender de red ni base de datos.' },
            { group: ['node:*', 'fs', 'path', 'crypto', 'http', 'net'], message: 'El motor debe ser puro y determinista.' },
            { group: ['@mtg3d/*', '!@mtg3d/engine'], message: 'El motor no importa otros paquetes del proyecto.' },
          ],
        },
      ],
    },
  },
);
