## Are you tired of losing your prompt data when you change your browser? Well not anymore.

Use this plugin with https://github.com/Enerccio/SillyTavern-PersistentItemizedPrompts extension to persist all prompts on your disk.

# Installation

1. Stop SillyTavern
2. Enable plugins in `config.yaml`
3. git clone this plugin into `plugins` folder
4. Install extension https://github.com/Enerccio/SillyTavern-PersistentItemizedPrompts
5. Start SillyTavern
6. ???
7. Profit

# Configuration

If you don't want to use compression (not sure why would you not), you can add 

```
persistentprompts:
 compression: false
```

into `config.yaml`

# Where are my prompts?

Your prompts are saved in `data/<your-user or default-user>/itemizedPrompts.sqlite` file.


# Warning

Requires SillyTavern `staging` branch for now!
