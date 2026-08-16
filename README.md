# WP-Publisher

WP-Publisher lets you write notes in Obsidian, converts the markdown file to HTML and publish them to WordPress Using REST API. The idea was to make writing web posts frictionless and more comfortable. I personally hate the Gutenberg editor, and since I write my posts in Obsidian first anyway I figured it would be nice to take out the middleman. 

Inspired by a Network Chuck video:

[![Network Chuck video](https://img.youtube.com/vi/dnE7c0ELEH8/hqdefault.jpg)](https://www.youtube.com/watch?v=dnE7c0ELEH8)

# Setup guide 

1. Download the files and drop them into your vault plugin folder. 
	Example 
		`<your vault>/.obsidian/plugins/<plugin-folder>/`
2. Go to your WordPress dashboard and click on edit profile. 
3. Scroll down to the bottom of the page until you see application password. (Some web hosts disable this by default if you do not see it. If you do see it, skip to step 5.)
4. Locate your web host, file manager and search for a file named something like **wp-config.php** and add the below line to the file and save it.
	 define( 'WP_APPLICATION_PASSWORDS_ENABLED', true );
5. Type something into the new application password name field like obsidian or whatever you would like and click add application password.
6. Immediately copy that password. It will disappear if you refresh the page.

7. Create a folder in your vault that you would like your posts to be stored. 
8. Open your Obsidian Settings and go to WP-Publisher. 
9. Paste in that application password, your site URL using HTTPS and your WordPress username. 
10. Lock lock password. 
11. In the Publishing Rules section, Point to the folder that you created in step 7.  Only notes in this folder can be published to your site.
12. The template section point it to your designated post template. I shipped the application with the one that use called [Site post template.md](https://github.com/Wicked-Shrapnel/Obsidian-2-WordPress-Plugin/blob/main/Site%20post%20template.md)
13. Scroll down to the Categories section and click Refresh with WordPress. you should now see all your site categories populated in a list. 
14. Go to the hotkeys section and record a publish and a draft hotkey. 
15. Navigate to your posts folder and create a new note. If you left automatic template on new note in published folder enabled then the template should automatically be applied to new notes in this folder. Notes created in this folder will also automatically have the default name of site post 1, 2, etc, But you can change that to whatever you would like. The title on the note will be the title on your site. 
You're all set up now.

## General Workflow

1. Create or open a note inside your configured publish folder.
2. Use the optional Site post template.md file. [Site post template.md](https://github.com/Wicked-Shrapnel/Obsidian-2-WordPress-Plugin/blob/main/Site%20post%20template.md)
 (If you already have your own template, you can keep using that one.)
4. Write the post in Markdown and fill in any frontmatter you want to control, such as `category:`, `excerpt:`, `comments:`, or `status:`.
5. Use `%% double percent signs %%` for private notes or reminders you do not want published.
6. Press your publish or draft hotkey, or click the sidebar publish button.
7. WP-Publisher publishes the note to WordPress, updates the existing post if it already has a `wp-id`, and keeps `wp-sync` updated.

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
