# Privacy practices tab: data usage

Do not tick "does not collect user data": Conscribe handles page data on the user's device (Chrome's User Data FAQ counts this as handling).

## Data types to tick (the dashboard's nine checkboxes)
- [x] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [x] Authentication information
- [ ] Personal communications
- [ ] Location
- [x] Web history
- [x] User activity
- [x] Website content

How they map: Website content is the page content, the picked element and the screenshot. Web history is the page and request addresses (URLs). User activity is the network monitoring (requests, responses, console messages) that the `debugger` permission reads. Authentication information and Personally identifiable information are what the page can show or send (sign-in tokens, form values, names, email addresses). The store has no "Form data" box, so form values fall under Website content and PII.

Health, financial and personal communications are left unticked: Conscribe does not look for them. If a recorded page happens to show them, the privacy policy says so ("can include ... financial, health or private messages if they appear on the page").

## Certifications (tick all three)
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Remote code
No.

## Privacy policy URL
`https://<NEW-VERCEL-HOST>/privacy` (from `site/privacy.html`; fill in after the new Vercel project is deployed. The old project is retired).
