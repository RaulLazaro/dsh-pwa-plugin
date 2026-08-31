# Integración del Plugin PWA en DSH

## Estructura del Plugin

```
dsh-pwa-plugin/
├── src/
│   ├── host/
│   │   └── index.js          # Plugin host (Node.js)
│   └── sw.js                 # Service Worker
├── public/
│   ├── manifest.webmanifest  # Manifest PWA
│   └── icons/                # Iconos generados
├── scripts/
│   ├── generate-icons.js     # Generador de iconos
│   ├── install.js            # Script de instalación
│   └── verify.js             # Verificación
├── example/
│   ├── cordis.patch.yml      # Ejemplo de configuración
│   └── package.json          # Ejemplo de package.json
└── package.json
```

## Instalación Rápida

### 1. Copiar el plugin

```bash
# Opción A: Copiar directamente
cp -r dsh-pwa-plugin ~/.dsh/plugins/

# Opción B: Crear symlink (recomendado para desarrollo)
ln -s /path/to/dsh-pwa-plugin ~/.dsh/plugins/dsh-pwa-plugin
```

### 2. Instalar dependencias

```bash
cd ~/.dsh/plugins/dsh-pwa-plugin
npm install  # Solo si necesitas generar iconos PNG con sharp
```

### 3. Configurar el profile web

#### En el `package.json` del profile:

```json
{
  "name": "dsh-web",
  "dependencies": {
    "dsh-pwa-plugin": "file:~/.dsh/plugins/dsh-pwa-plugin"
  }
}
```

#### En el `cordis.patch.yml` del profile:

```yaml
# Añadir al final del archivo
- insert:
    - id: pwa
      name: 'dsh-pwa-plugin'
```

### 4. Reiniciar DSH

```bash
dsh web
```

## Configuración Avanzada

### Opciones del Plugin

El plugin soporta las siguientes opciones en `cordis.patch.yml`:

```yaml
- id: pwa
  name: 'dsh-pwa-plugin'
  config:
    # Habilitar caché offline (default: true)
    enableOfflineCache: true

    # Habilitar prompt de instalación (default: true)
    enableInstallPrompt: true

    # Intervalo de verificación de actualizaciones en ms (default: 3600000)
    updateIntervalMs: 3600000
```

### Iconos Personalizados

Para usar iconos personalizados:

1. Coloca tus iconos PNG en `public/icons/`
2. Nombra los archivos como `icon-192.png` y `icon-512.png`
3. Actualiza el `manifest.webmanifest` si es necesario

### Generar Iconos PNG

Si necesitas generar iconos PNG a partir del SVG:

```bash
cd ~/.dsh/plugins/dsh-pwa-plugin
npm install sharp
node scripts/generate-icons.js
```

## Cómo Funciona

### Flujo de Instalación

1. **Carga del Plugin**: DSH carga el plugin host durante el boot
2. **Inyección de Script**: El plugin inyecta el script de registro en el HTML
3. **Registro del Service Worker**: El navegador registra el service worker
4. **Caché de Assets**: El service worker cachea assets estáticos
5. **PWA Listo**: La app está lista para instalación y uso offline

### Estrategia de Caché

| Tipo de Recurso | Estrategia | Descripción |
|----------------|------------|-------------|
| HTML | Network-first | Siempre intenta obtener la versión más reciente |
| JS/CSS/Fonts | Cache-first | Sirve de caché si está disponible |
| Imágenes | Cache-first | Caché para carga rápida |
| API calls | No cache | Siempre van a la red |

### Actualizaciones

1. El service worker verifica actualizaciones cada hora
2. Cuando detecta una actualización, muestra un diálogo al usuario
3. Si el usuario acepta, recarga la página con la nueva versión
4. Los assets nuevos se cachean automáticamente

## Solución de Problemas

### El service worker no se registra

- Verifica que estés usando HTTPS (excepto localhost)
- Revisa la consola del navegador para errores
- Asegúrate de que el archivo `/sw.js` es accesible

### Los iconos no aparecen

- Verifica que los iconos existen en `public/icons/`
- Revisa el `manifest.webmanifest` para asegurarte de que las rutas son correctas

### La app no se puede instalar

- Verifica que el manifest sea válido
- Asegúrate de que el service worker esté registrado
- Chrome requiere que la app cumpla con los criterios de instalación

## Desarrollo

### Estructura del Código

- `src/host/index.js`: Plugin host que maneja la inyección de scripts
- `src/sw.js`: Service Worker para caché offline
- `public/manifest.webmanifest`: Manifest PWA

### Testing

```bash
# Verificar instalación
node scripts/verify.js

# Generar iconos
node scripts/generate-icons.js
```

### Debugging

1. Abre las DevTools del navegador
2. Ve a la pestaña "Application"
3. Revisa "Service Workers" para ver el estado
4. Revisa "Manifest" para ver la configuración PWA

## Licencia

MIT
