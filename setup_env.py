"""
setup_env.py
Interactive setup script to generate the .env configuration file.
"""

from pathlib import Path

ENV_PATH = Path(".env")

DEFAULT_CONFIG = {
    "IMWB_SERVER": ("", "SQL Server IP/Hostname (leave empty for simulated mode)"),
    "IMWB_DATABASE": ("IMWB_STWB", "Target Database Name"),
    "IMWB_USER": ("sa", "Database Username"),
    "IMWB_PASSWORD": ("", "Database Password"),
    "ODBC_DRIVER": ("ODBC Driver 18 for SQL Server", "Installed ODBC Driver"),
    "IMWB_TIMEZONE": ("Asia/Kolkata", "Plant Local Timezone"),
    "PORT": ("5000", "Dashboard Web Port"),
}

def main():
    print("=" * 60)
    print(" In-Motion Weighbridge Dashboard - .env Configuration Setup")
    print("=" * 60)
    print("Press Enter to keep the default/suggested value in brackets.\n")

    lines = [
        "# In-Motion + Static Weighbridge Dashboard Configuration",
        "# Auto-generated configuration\n"
    ]

    for key, (default_val, prompt_desc) in DEFAULT_CONFIG.items():
        user_input = input(f"{prompt_desc} [{default_val}]: ").strip()
        val = user_input if user_input else default_val
        lines.append(f"{key}={val}")

    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nConfiguration saved successfully to '{ENV_PATH.resolve()}'.")

if __name__ == "__main__":
    main()