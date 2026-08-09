# WP-Publisher

WP-Publisher lets you write notes in Obsidian and publish them to WordPress with a dedicated workflow. It converts Markdown to HTML, sends posts over the WordPress REST API, tracks the WordPress post ID locally, and supports publish/draft hotkeys.

Inspired by Network Chuck:

[![Network Chuck video](https://img.youtube.com/vi/dnE7c0ELEH8/hqdefault.jpg)](https://www.youtube.com/watch?v=dnE7c0ELEH8)

## General Workflow

1. Create or open a note inside your configured publish folder.
2. Write the post in Markdown and fill in any frontmatter you want to control, such as `category:`, `excerpt:`, `comments:`, or `status:`.
3. Use `%% double percent signs %%` for private notes or reminders you do not want published.
4. Press your publish or draft hotkey, or click the sidebar publish button.
5. WP-Publisher publishes the note to WordPress, updates the existing post if it already has a `wp-id`, and keeps `wp-sync` updated.

## What It Handles

- Converts Markdown to HTML before publishing
- Creates missing WordPress categories when enabled
- Supports publish, draft, and revert-to-draft workflows
- Applies your selected template to new notes in the publish folder
- Tracks local sync state so you can see when a post is out of sync

## Disclosures

- Requires a WordPress site reachable over HTTPS
- Uses a WordPress application password for authentication
- Stores the WordPress URL, username, application password, category list, template path, and local sync metadata in plugin settings
- Reads files from the configured publish folder and uploads any referenced images to WordPress
- Does not include telemetry or analytics

For installation and first-time setup, see the full setup guide in this repository.
