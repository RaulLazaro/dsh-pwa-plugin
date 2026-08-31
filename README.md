# DSH PWA Plugin

Plugin PWA para DeepSeek Harness que añade soporte offline y capacidad de instalación como aplicación.

## Características

- **Service Worker** con estrategia de caché inteligente
- **Manifest PWA** completo con iconos y metadata
- **Actualizaciones automáticas** con notificación al usuario
- **Offline-first** para assets estáticos

## Instalación

### Opción 1: Plugin local

```bash
# Copiar el plugin al directorio de plugins de DSH
cp -r dsh-pwa-plugin ~/.dsh/plugins/

# O crear un symlink
ln -s /path/to/dsh-pwa-plugin ~/.dsh/plugins/dsh-pwa-plugin
```

### Opción 2: Usar con el profile web

Añadir al `package.json` del profile web:

```json
{
  "dependencies": {
    "dsh-pwa-plugin": "file:../dsh-pwa-plugin"
  }
}
```

Y en `cordis.patch.yml`:

```yaml
- insert:
    - id: pwa
      name: 'dsh-pwa-plugin'
```

## Generar iconos PNG

Para generar los iconos PNG necesarios para el manifest:

```bash
npm install sharp --save-dev
node scripts/generate-icons.js
```

## Cómo funciona

1. El plugin host inyecta un script de registro del service worker en el HTML
2. El service worker cachea assets estáticos para uso offline
3. El manifest permite instalar la app como PWA
4. Las actualizaciones se detectan automáticamente

## Estrategia de caché

- **HTML**: Network-first (siempre intenta obtener la versión más reciente)
- **Assets estáticos** (JS, CSS, fonts, imágenes): Cache-first (sirve de caché si disponible)
- **API calls**: No se cachean (siempre van a la red)

## Limitaciones

- Requiere HTTPS para funcionar (excepto localhost)
- El service worker no puede cachear llamadas a la API
- Las actualizaciones requieren recarga de la página

## Licencia

MIT
