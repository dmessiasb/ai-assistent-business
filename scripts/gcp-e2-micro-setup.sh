#!/usr/bin/env bash
# ==============================================================================
# Script de Otimização para Google Cloud Compute Engine (e2-micro Always Free)
# Regiões Gratuitas: us-central1, us-west1 ou us-east1 (Disco Standard 30GB)
# ==============================================================================
set -e

echo "1. Criando 2GB de Swap para estabilidade total na VM e2-micro (1GB RAM)..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "2. Instalando Node.js 24 LTS e PM2..."
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2

echo "3. Ambiente pronto! Para iniciar a aplicação em produção:"
echo "   npm install --omit=dev"
echo "   pm2 start 'node --env-file=.env src/server.ts' --name whatsapp-hub --max-memory-restart 450M"
echo "   pm2 save && pm2 startup"
