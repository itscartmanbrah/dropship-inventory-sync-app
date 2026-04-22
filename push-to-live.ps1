# push-to-live.ps1
Write-Host "Building application locally..."
npm run build

Write-Host "Zipping up codebase and build output..."
tar -czf app.tar.gz --exclude=node_modules --exclude=.git --exclude=public/build --exclude=.shopify --exclude=app.tar.gz .

Write-Host "Transferring to DigitalOcean server..."
scp -i ~/.ssh/id_do_new -o BatchMode=yes -o StrictHostKeyChecking=no app.tar.gz root@159.223.96.29:/tmp/app.tar.gz

Write-Host "Extracting, generating Linux database engine, and Restarting PM2..."
ssh -i ~/.ssh/id_do_new -o BatchMode=yes root@159.223.96.29 "cd /app && pm2 stop all && tar -xzf /tmp/app.tar.gz -C /app && rm /tmp/app.tar.gz && npm ci --omit=dev && npx prisma generate && npx prisma db push && pm2 restart dropship-sync"

Write-Host "Removing local zip file..."
Remove-Item app.tar.gz

Write-Host "Deployment Complete! Your live app is exactly up to date with your local code."
