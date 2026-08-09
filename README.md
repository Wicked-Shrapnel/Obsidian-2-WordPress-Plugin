# WP-Publisher

This tool lets you write notes in Obsidian and publish them to your WordPress site with a single hotkey press. It converts your Markdown to HTML, let's you assign the category, and sends it to WordPress via the REST API. A second hotkey lets you save a post as a draft or revert a live post back to draft. I was inspired by this video from Network Chuck. This is a simplified version of his idea but the principle is still the same. 

[![Network Chuck video](https://img.youtube.com/vi/dnE7c0ELEH8/hqdefault.jpg)](https://www.youtube.com/watch?v=dnE7c0ELEH8)

The goal was to create a more comfortable writing experience. If you're anything like me, you write your posts in Obsidian anyway, so why not just take out the step of copying it to Gutenberg and making edits? 
## Privacy and data storage

WP Publisher connects to your WordPress site over the network using the WordPress REST API.

The plugin stores the following data locally in Obsidian plugin settings so it can function:

- WordPress site URL
- WordPress username
- WordPress application password
- local sync/cache data such as WordPress post IDs and content hashes
- saved category and template settings

The application password is hidden in the settings UI after it is saved, but it is not encrypted or hashed by the plugin. Someone with access to the vault files may be able to read it from the local plugin data.

WP Publisher does not include telemetry or analytics.


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
12. The template section point it to your designated post template. I shipped the application with the one that use called `Site post template.md`
13. Scroll down to the Categories section and click Refresh with WordPress. you should now see all your site categories populated in a list. 
14. Go to the hotkeys section and record a publish and a draft hotkey. 
15. Navigate to your posts folder and create a new note. If you left automatic template on new note in published folder enabled then the template should automatically be applied to new notes in this folder. Notes created in this folder will also automatically have the default name of site post 1, 2, etc, But you can change that to whatever you would like. The title on the note will be the title on your site. 
You're all set up now.

 
## General Workflow

1. Create or open a note inside your configured publish folder.
2. Write the post in Markdown and fill in any frontmatter you want to control, such as `category:`, `excerpt:`, `comments:`, or `status:`.
3. Use `%% double percent signs %%` for private notes or reminders you do not want published.
4. Press your publish or draft hotkey, or click the sidebar publish button.
5. WP-Publisher publishes the note to WordPress, updates the existing post if it already has a `wp-id`, and keeps `wp-sync` updated.
For installation and first-time setup, see the full setup guide in this repository.
