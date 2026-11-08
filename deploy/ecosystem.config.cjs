// Run WITHOUT Docker, with PM2:  cd api && npm ci && npx prisma generate && npm run build
//   npx prisma migrate deploy && pm2 start ../deploy/ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'prgate-api',
      cwd: __dirname + '/../api',
      script: 'dist/main.js',
      node_args: '--env-file=.env.production', // loads the settings file (Node 20.6+)
      env: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
      autorestart: true,
    },
  ],
};
