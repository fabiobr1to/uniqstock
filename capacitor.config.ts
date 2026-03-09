import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.uniqcode.uniqstock',
  appName: 'UniqStock',
  webDir: 'public',
  server: {
    url: 'https://SEU-DOMINIO-OU-IP-PUBLICO',
    cleartext: false
  }
};

export default config;
