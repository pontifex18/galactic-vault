import os
import json

# Configuration
GAMES_DIR = "games"
DEFAULT_CONFIG = {
    "external": False,
    "description": None
}

def initialize_game_configs():
    # Ensure the games directory actually exists
    if not os.path.exists(GAMES_DIR):
        print(f"Directory '{GAMES_DIR}' not found. Please run this from the root folder.")
        return

    # Count of files created
    created_count = 0
    skipped_count = 0

    # Iterate through each item in the games directory
    for folder_name in os.listdir(GAMES_DIR):
        folder_path = os.path.join(GAMES_DIR, folder_name)

        # Check if the item is a directory
        if os.path.isdir(folder_path):
            config_path = os.path.join(folder_path, 'config.json')

            # Check if config.json already exists
            if not os.path.exists(config_path):
                try:
                    with open(config_path, 'w') as f:
                        json.dump(DEFAULT_CONFIG, f, indent=4)
                    print(f"✅ Created: {config_path}")
                    created_count += 1
                except Exception as e:
                    print(f"❌ Error creating {config_path}: {e}")
            else:
                print(f"⏩ Skipped (Already exists): {config_path}")
                skipped_count += 1

    print(f"\n--- Process Complete ---")
    print(f"Files created: {created_count}")
    print(f"Files skipped: {skipped_count}")

if __name__ == "__main__":
    initialize_game_configs()